"""Opt-in root-run live WSL worker boundary checks; no model or credential required."""
import json
import os
import pathlib
import signal
import socket
import threading
import subprocess
import tempfile
import unittest

LAUNCHER = pathlib.Path(__file__).resolve().parents[2] / 'scripts' / 'wsl-codex-worker.py'


@unittest.skipUnless(os.geteuid() == 0 and os.environ.get('MYCELINK_LIVE_WSL_WORKER') == '1', 'requires explicit WSL root opt-in')
class WorkerIsolationTest(unittest.TestCase):
    def test_separate_principal_snapshot_proposal_and_inherited_fd(self):
        with tempfile.TemporaryDirectory(prefix='mycelink-worker-test-') as temp:
            base = pathlib.Path(temp)
            source = base / 'source'
            source.mkdir()
            (source / 'allowed').mkdir()
            (source / 'allowed' / 'input.txt').write_text('INPUT\n')
            protected = base / 'protected.txt'
            protected.write_text('ORIGINAL\n')
            # A source hardlink to protected state must never enter the worker's writable transport.
            os.link(protected, source / 'allowed' / 'alias.txt')
            report = base / 'report.json'
            fd = os.open(protected, os.O_WRONLY)
            os.dup2(fd, 9)
            os.set_inheritable(9, True)
            os.close(fd)
            try:
                cmd = ['python3', str(LAUNCHER), '--source', str(source), '--report', str(report), '--claim', 'claim-1', '--generation', 'generation-1', '--role', 'worker', '--', '/bin/sh', '-c', '''
                    id -u > /proposal/uid
                    cat /work/allowed/input.txt > /proposal/answer
                    printf ATTACK > /work/allowed/alias.txt 2>/dev/null || :
                    printf ATTACK > /protected.txt 2>/dev/null || :
                    printf ATTACK >&9 2>/dev/null || :
                    if test -e /mnt/c/Windows; then echo VISIBLE > /proposal/host; fi
                    if test -e /init; then echo VISIBLE > /proposal/interop; fi
                    printf 'PROPOSED\n' > /proposal/allowed.txt
                ''']
                run = subprocess.run(cmd, text=True, capture_output=True, timeout=30, close_fds=False)
                self.assertEqual(run.returncode, 0, run.stderr)
            finally:
                os.close(9)
            self.assertEqual(protected.read_text(), 'ORIGINAL\n')
            record = json.loads(report.read_text())
            self.assertEqual(record['claim'], 'claim-1')
            self.assertEqual(record['generation'], 'generation-1')
            self.assertEqual(record['role'], 'worker')
            self.assertEqual(record['proposals']['answer'], 'INPUT\n')
            self.assertEqual(record['proposals']['allowed.txt'], 'PROPOSED\n')
            self.assertNotIn('host', record['proposals'])
            self.assertNotIn('interop', record['proposals'])
            self.assertNotEqual(record['proposals']['uid'].strip(), '0')

    def test_reviewer_has_independent_principal_and_proposal_slot(self):
        with tempfile.TemporaryDirectory(prefix='mycelink-review-test-') as temp:
            base = pathlib.Path(temp)
            source = base / 'source'
            source.mkdir()
            identities = {}
            for role in ('worker', 'reviewer'):
                report = base / (role + '.json')
                run = subprocess.run(['python3', str(LAUNCHER), '--source', str(source),
                    '--report', str(report), '--claim', 'claim-1', '--generation', 'generation-1',
                    '--role', role, '--', '/bin/sh', '-c', 'id -u > /proposal/uid'],
                    text=True, capture_output=True, timeout=30)
                self.assertEqual(run.returncode, 0, run.stderr)
                record = json.loads(report.read_text())
                self.assertEqual(record['role'], role)
                identities[role] = record['proposals']['uid'].strip()
            self.assertNotEqual(identities['worker'], identities['reviewer'])

    def test_refuses_symlink_proposal_without_writing_report(self):
        with tempfile.TemporaryDirectory(prefix='mycelink-link-test-') as temp:
            base = pathlib.Path(temp)
            source = base / 'source'
            source.mkdir()
            report = base / 'report.json'
            run = subprocess.run(['python3', str(LAUNCHER), '--source', str(source),
                '--report', str(report), '--claim', 'claim-1', '--generation', 'generation-1',
                '--role', 'worker', '--', '/bin/sh', '-c', 'ln -s /etc/passwd /proposal/alias'],
                text=True, capture_output=True, timeout=30)
            self.assertNotEqual(run.returncode, 0)
            self.assertFalse(report.exists())
    def test_private_unix_bridge_is_only_network_channel(self):
        with tempfile.TemporaryDirectory(prefix='mycelink-bridge-test-') as temp:
            base = pathlib.Path(temp)
            base.chmod(0o711)
            source = base / 'source'
            source.mkdir()
            bridge = base / 'bridge.sock'
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(str(bridge))
            bridge.chmod(0o666)
            listener.listen(1)
            received = []
            def service():
                listener.settimeout(5)
                identity = json.dumps({'claim': 'claim-1', 'generation': 'generation-1',
                    'role': 'worker', 'uid': __import__('pwd').getpwnam('mycelink-codex-worker').pw_uid}).encode()
                conn, _ = listener.accept()
                with conn:
                    conn.recv(1024)
                    conn.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: ' + str(len(identity)).encode() +
                                 b'\r\nConnection: close\r\n\r\n' + identity)
                conn, _ = listener.accept()
                with conn:
                    received.append(conn.recv(20))
                    conn.sendall(b'bridge-only')
            thread = threading.Thread(target=service, daemon=True)
            thread.start()
            report = base / 'report.json'
            # Relay is disposable worker-side plumbing. The host Unix service remains
            # the policy authority, and direct AF_INET outside loopback must fail.
            probe = '''
import pathlib, socket, time
for attempt in range(30):
    try:
        sock = socket.create_connection(('127.0.0.1', 18547), timeout=0.2)
        break
    except OSError:
        time.sleep(0.05)
else:
    raise RuntimeError('loopback relay inaccessible')
sock.sendall(b'ping')
pathlib.Path('/proposal/bridge').write_bytes(sock.recv(20))
outside = socket.socket()
outside.settimeout(1)
try:
    outside.connect(('1.1.1.1', 443))
except OSError:
    pathlib.Path('/proposal/direct-denied').write_text('YES')
'''
            cmd = ['python3', str(LAUNCHER), '--source', str(source), '--report', str(report),
                   '--claim', 'claim-1', '--generation', 'generation-1', '--role', 'worker',
                   '--bridge-socket', str(bridge), '--', '/bin/sh', '-c',
                   'socat TCP-LISTEN:18547,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/bridge.sock & '
                   'exec python3 -c "$1"', 'sh', probe]
            try:
                run = subprocess.run(cmd, text=True, capture_output=True, timeout=15)
                self.assertEqual(run.returncode, 0, run.stderr)
                data = json.loads(report.read_text())['proposals']
                self.assertEqual(data['bridge'], 'bridge-only')
                self.assertEqual(data['direct-denied'], 'YES')
                self.assertEqual(received, [b'ping'])
            finally:
                listener.close()
                thread.join(timeout=6)
    def test_real_linux_codex_binary_has_no_auth_mount(self):
        with tempfile.TemporaryDirectory(prefix='mycelink-codex-binary-test-') as temp:
            base = pathlib.Path(temp)
            source = base / 'source'
            source.mkdir()
            report = base / 'report.json'
            package = '/var/lib/mycelink-codex/pkg/node_modules'
            run = subprocess.run(['python3', str(LAUNCHER), '--source', str(source),
                '--report', str(report), '--claim', 'claim-1', '--generation', 'generation-1',
                '--role', 'worker', '--codex-install', package, '--', '/bin/sh', '-c',
                '/usr/local/bin/node /opt/node_modules/@openai/codex/bin/codex.js --version > /proposal/version; '
                'if test -e /home/psh09/.codex/auth.json; then echo EXPOSED > /proposal/auth; fi'],
                text=True, capture_output=True, timeout=30)
            self.assertEqual(run.returncode, 0, run.stderr)
            proposals = json.loads(report.read_text())['proposals']
            self.assertEqual(proposals['version'].strip(), 'codex-cli 0.163.0')
            self.assertNotIn('auth', proposals)
    def test_actual_codex_reaches_only_scoped_fake_api(self):
        import importlib.util
        bridge_path = pathlib.Path(__file__).resolve().parents[2] / 'scripts' / 'wsl-codex-api-bridge.py'
        spec = importlib.util.spec_from_file_location('codex_api_bridge', bridge_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='mycelink-codex-api-test-') as temp:
            base = pathlib.Path(temp)
            base.chmod(0o711)
            source = base / 'source'
            source.mkdir()
            report = base / 'report.json'
            calls = []
            def fake_upstream(path, body, headers):
                calls.append(path)
                return (401, b'{"error":{"message":"fake auth denied"}}', 'application/json')
            bridge_socket = base / 'bridge.sock'
            server = module.make_server(str(bridge_socket), fake_upstream,
                expected_uid=__import__('pwd').getpwnam('mycelink-codex-worker').pw_uid,
                claim='claim-1', generation='generation-1', role='worker')
            bridge_socket.chmod(0o666)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                program = '''
socat TCP-LISTEN:18547,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/bridge.sock &
OPENAI_API_KEY=placeholder timeout 12s /usr/local/bin/node /opt/node_modules/@openai/codex/bin/codex.js \\
  exec --ignore-user-config --ephemeral --skip-git-repo-check --json --cd /work \\
  --sandbox read-only -c approval_policy=never \\
  -c 'openai_base_url="http://127.0.0.1:18547/v1"' 'Print the word OK' \\
  > /proposal/codex-out 2>/proposal/codex-err
printf '%s' "$?" > /proposal/status
'''
                run = subprocess.run(['python3', str(LAUNCHER), '--source', str(source),
                    '--report', str(report), '--claim', 'claim-1', '--generation', 'generation-1',
                    '--role', 'worker', '--bridge-socket', str(bridge_socket),
                    '--codex-install', '/var/lib/mycelink-codex/pkg/node_modules',
                    '--', '/bin/sh', '-c', program], text=True, capture_output=True, timeout=25)
                self.assertEqual(run.returncode, 0, run.stderr)
                proposals = json.loads(report.read_text())['proposals']
                self.assertTrue(calls, proposals['codex-err'][:500])
                self.assertEqual(set(calls), {'/v1/responses'})
                self.assertNotEqual(proposals['status'], '0')
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
    @unittest.skipUnless(os.environ.get('MYCELINK_LIVE_WSL_CODEX_AUTH') == '1', 'separate opt-in for authenticated Codex turn')
    def test_authenticated_codex_via_scoped_bridge(self):
        import importlib.util
        import pwd
        import time
        bridge_path = pathlib.Path(__file__).resolve().parents[2] / 'scripts' / 'wsl-codex-api-bridge.py'
        spec = importlib.util.spec_from_file_location('codex_api_bridge_live', bridge_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='mycelink-live-codex-') as temp:
            base = pathlib.Path(temp)
            base.chmod(0o711)
            source = base / 'source'
            source.mkdir()
            report = base / 'report.json'
            bridge_dir = base / 'broker'
            bridge_dir.mkdir()
            principal = pwd.getpwnam('psh09')
            worker = pwd.getpwnam('mycelink-codex-worker')
            os.chown(bridge_dir, principal.pw_uid, worker.pw_gid)
            bridge_dir.chmod(0o2711)
            bridge_socket = bridge_dir / 'bridge.sock'
            audit_file = bridge_dir / 'audit.jsonl'
            broker_pid = os.fork()
            if broker_pid == 0:
                os.setgroups([])
                os.setgid(principal.pw_gid)
                os.setuid(principal.pw_uid)
                service = module.make_server(str(bridge_socket),
                    module.trusted_upstream('/home/psh09/.codex/auth.json'), expected_uid=worker.pw_uid,
                    claim='claim-1', generation='generation-1', role='worker')
                def audit(event, method, path):
                    with audit_file.open('a') as output:
                        output.write(json.dumps([event, method, path]) + '\n')
                service.audit = audit
                bridge_socket.chmod(0o660)
                service.serve_forever()
                os._exit(0)
            try:
                for _ in range(100):
                    if bridge_socket.exists():
                        break
                    time.sleep(0.05)
                self.assertTrue(bridge_socket.exists(), 'broker did not start')
                program = '''
socat TCP-LISTEN:18547,bind=127.0.0.1,reuseaddr,fork UNIX-CONNECT:/run/bridge.sock &
OPENAI_API_KEY=placeholder timeout 42s /usr/local/bin/node /opt/node_modules/@openai/codex/bin/codex.js \\
  exec --ignore-user-config --ephemeral --skip-git-repo-check --json --cd /work \\
  --sandbox read-only -c approval_policy=never \\
  -c 'openai_base_url="http://127.0.0.1:18547/v1"' 'Print the word OK' \\
  > /proposal/codex-out 2>/proposal/codex-err
printf '%s' "$?" > /proposal/status
'''
                run = subprocess.run(['python3', str(LAUNCHER), '--source', str(source),
                    '--report', str(report), '--claim', 'claim-1', '--generation', 'generation-1',
                    '--role', 'worker', '--timeout-sec', '50', '--bridge-socket', str(bridge_socket),
                    '--codex-install', '/var/lib/mycelink-codex/pkg/node_modules',
                    '--', '/bin/sh', '-c', program], text=True, capture_output=True, timeout=65)
                self.assertEqual(run.returncode, 0, run.stderr[:200])
                proposal = json.loads(report.read_text())['proposals']
                events = [json.loads(x).get('type') for x in proposal['codex-out'].splitlines() if x.startswith('{')]
                errors = [json.loads(x).get('message', '') for x in proposal['codex-out'].splitlines()
                          if x.startswith('{') and json.loads(x).get('type') == 'error']
                classes = [[code for code in ('400', '401', '403', '404', '429', '500', '502', 'network', 'timeout')
                            if code in str(message).lower()] for message in errors]
                audit = [json.loads(line) for line in audit_file.read_text().splitlines()] if audit_file.exists() else []
                self.assertEqual(proposal['status'], '0',
                    f'nonzero Codex status; events={events}, error classes={classes}, broker={audit}')
                self.assertIn('turn.completed', events)
            finally:
                os.kill(broker_pid, signal.SIGTERM)
                os.waitpid(broker_pid, 0)
    def test_mismatched_bridge_generation_blocks_worker_launch(self):
        import importlib.util
        import pwd
        bridge_path = pathlib.Path(__file__).resolve().parents[2] / 'scripts' / 'wsl-codex-api-bridge.py'
        spec = importlib.util.spec_from_file_location('codex_api_bridge_generation', bridge_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory(prefix='mycelink-generation-test-') as temp:
            base = pathlib.Path(temp)
            base.chmod(0o711)
            source = base / 'source'
            source.mkdir()
            report = base / 'report.json'
            sock = base / 'bridge.sock'
            worker = pwd.getpwnam('mycelink-codex-worker')
            server = module.make_server(str(sock), lambda *args: (200, b'', 'application/json'),
                expected_uid=worker.pw_uid, claim='claim-1', generation='stale-generation', role='worker')
            sock.chmod(0o666)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                run = subprocess.run(['python3', str(LAUNCHER), '--source', str(source),
                    '--report', str(report), '--claim', 'claim-1', '--generation', 'generation-1',
                    '--role', 'worker', '--bridge-socket', str(sock), '--', '/bin/sh', '-c',
                    'echo RUN > /proposal/executed'], text=True, capture_output=True, timeout=10)
                self.assertNotEqual(run.returncode, 0)
                self.assertFalse(report.exists())
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
    def test_timeout_reaps_detached_worker_descendants(self):
        import uuid
        import time
        marker = 'mycelink-descendant-' + uuid.uuid4().hex
        def matching():
            found = []
            for entry in pathlib.Path('/proc').iterdir():
                if not entry.name.isdigit():
                    continue
                try:
                    args = (entry / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
                    if marker in args and 'python3 -c' in args:
                        found.append(int(entry.name))
                except (OSError, ValueError):
                    pass
            return found
        with tempfile.TemporaryDirectory(prefix='mycelink-descendant-test-') as temp:
            base = pathlib.Path(temp)
            source = base / 'source'
            source.mkdir()
            report = base / 'report.json'
            program = 'setsid python3 -c "import time; time.sleep(20) # ' + marker + '" </dev/null >/dev/null 2>&1 & sleep 5'
            try:
                run = subprocess.run(['python3', str(LAUNCHER), '--source', str(source),
                    '--report', str(report), '--claim', 'claim-1', '--generation', 'generation-1',
                    '--role', 'worker', '--timeout-sec', '2', '--', '/bin/sh', '-c', program],
                    text=True, capture_output=True, timeout=8)
                self.assertNotEqual(run.returncode, 0)
                self.assertFalse(report.exists())
                time.sleep(0.2)
                self.assertEqual(matching(), [], 'detached descendant retained WSL process/channel after timeout')
            finally:
                for pid in matching():
                    os.kill(pid, signal.SIGKILL)

    def test_interrupted_generation_writes_no_report_and_followup_runs(self):
        with tempfile.TemporaryDirectory(prefix='mycelink-interrupt-test-') as temp:
            base = pathlib.Path(temp)
            source = base / 'source'
            source.mkdir()
            stale = base / 'stale.json'
            failed = subprocess.run(['python3', str(LAUNCHER), '--source', str(source),
                '--report', str(stale), '--claim', 'claim-1', '--generation', 'old',
                '--role', 'worker', '--timeout-sec', '1', '--', '/bin/sh', '-c',
                'sleep 4; echo OLD > /proposal/answer'], text=True, capture_output=True, timeout=8)
            self.assertNotEqual(failed.returncode, 0)
            self.assertFalse(stale.exists())
            current = base / 'current.json'
            succeeded = subprocess.run(['python3', str(LAUNCHER), '--source', str(source),
                '--report', str(current), '--claim', 'claim-1', '--generation', 'new',
                '--role', 'worker', '--', '/bin/sh', '-c', 'echo NEW > /proposal/answer'],
                text=True, capture_output=True, timeout=8)
            self.assertEqual(succeeded.returncode, 0, succeeded.stderr)
            self.assertEqual(json.loads(current.read_text())['proposals']['answer'].strip(), 'NEW')


if __name__ == '__main__':
    unittest.main()
