"""Allowlist tests for the Unix-socket credential broker. No real API calls."""
import http.client
import hashlib
import importlib.util
import json
import os
import pathlib
import socket
import tempfile
import threading
import unittest
import pwd

BRIDGE_PATH = pathlib.Path(__file__).resolve().parents[2] / 'scripts' / 'wsl-codex-api-bridge.py'


def load_bridge():
    spec = importlib.util.spec_from_file_location('wsl_codex_api_bridge', BRIDGE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__('local')
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.connect(self.path)


class BridgePolicyTest(unittest.TestCase):
    def test_root_ledger_attestation_refuses_missing_or_unfinished_roles(self):
        turn_path = BRIDGE_PATH.with_name('wsl-codex-turn.py')
        spec = importlib.util.spec_from_file_location('wsl_codex_turn_attestation', turn_path)
        turn = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(turn)
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            for role, count in (('worker', 2), ('reviewer', 1)):
                lines = ([{'event': 'deny', 'method': 'GET', 'path': '/v1/responses'}] +
                         [{'event': event, 'method': 'POST', 'path': '/v1/responses'}
                          for _ in range(count) for event in ('admit', 'upstream-200')])
                (root / (role + '.jsonl')).write_text(''.join(json.dumps(line) + '\n' for line in lines))
                (root / (role + '.jsonl')).chmod(0o600)
            receipt = turn.attest_api_audit(root)
            self.assertEqual(receipt['worker']['apiRequests'], 2)
            self.assertEqual(receipt['reviewer']['apiRequests'], 1)
            self.assertEqual(receipt['worker']['sha256'], hashlib.sha256((root / 'worker.jsonl').read_bytes()).hexdigest())
            (root / 'reviewer.jsonl').write_text('{"event":"admit","method":"POST","path":"/v1/responses"}\n')
            with self.assertRaises(ValueError):
                turn.attest_api_audit(root)
            (root / 'reviewer.jsonl').unlink()
            with self.assertRaises((ValueError, FileNotFoundError)):
                turn.attest_api_audit(root)

    def test_reviewer_bridge_requires_distinct_registered_linux_principal(self):
        bridge = load_bridge()
        worker = pwd.getpwnam('mycelink-codex-worker')
        reviewer = pwd.getpwnam('mycelink-codex-reviewer')
        self.assertNotEqual(worker.pw_uid, reviewer.pw_uid)
        self.assertEqual(bridge.bridge_principal('reviewer', reviewer.pw_uid, reviewer.pw_gid), 'reviewer')
        for role, uid, gid in [('reviewer', worker.pw_uid, worker.pw_gid),
                               ('worker', reviewer.pw_uid, reviewer.pw_gid),
                               ('controller', reviewer.pw_uid, reviewer.pw_gid)]:
            with self.assertRaises(ValueError):
                bridge.bridge_principal(role, uid, gid)

    def test_allowlisted_responses_only_and_auth_stays_in_broker(self):
        bridge = load_bridge()
        with tempfile.TemporaryDirectory() as temp:
            calls = []
            def upstream(path, body, headers):
                calls.append((path, body, headers))
                return (200, b'{"ok":true}', 'application/json')
            server = bridge.make_server(str(pathlib.Path(temp) / 'bridge.sock'), upstream)
            audits = []
            server.audit = lambda event, method, path: audits.append((event, method, path))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                def request(method, path, body=b'{}', extra=None):
                    conn = UnixHTTP(server.server_address)
                    conn.request(method, path, body=body, headers={'Authorization': 'Bearer untrusted',
                        'Content-Type': 'application/json', **(extra or {})})
                    response = conn.getresponse()
                    value = response.status, response.read()
                    conn.close()
                    return value
                self.assertEqual(request('POST', '/v1/responses')[0], 200)
                for method, path in [('GET', '/v1/responses'), ('POST', '/v1/models'),
                                      ('POST', '/v1/responses/../files'), ('POST', 'http://example.com/'),
                                      ('CONNECT', 'example.com:443'), ('POST', '/v1/responses?url=https://example.com')]:
                    self.assertEqual(request(method, path)[0], 403, (method, path))
                self.assertEqual(len(calls), 1)
                path, body, headers = calls[0]
                self.assertEqual(path, '/v1/responses')
                self.assertEqual(body, b'{}')
                self.assertNotIn('authorization', {k.lower() for k in headers})
                self.assertNotIn('host', {k.lower() for k in headers})
                self.assertIn(('deny', 'GET', '/v1/responses'), audits)
                self.assertIn(('deny', 'POST', '/v1/models'), audits)
                self.assertIn(('upstream-200', 'POST', '/v1/responses'), audits)
                self.assertNotIn('example.com', repr(audits))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)
    def test_rejects_duplicate_lengths_and_non_json_before_upstream(self):
        bridge = load_bridge()
        with tempfile.TemporaryDirectory() as temp:
            calls = []
            server = bridge.make_server(str(pathlib.Path(temp) / 'broker.sock'),
                lambda path, body, headers: (calls.append(body) or (200, b'OK', 'text/plain')))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                for request in (
                    b'POST /v1/responses HTTP/1.1\r\nHost: local\r\nContent-Type: application/json\r\nContent-Length: 2\r\nContent-Length: 999\r\n\r\n{}',
                    b'POST /v1/responses HTTP/1.1\r\nHost: local\r\nContent-Type: application/json\r\nContent-Length: 3\r\n\r\nBAD',
                ):
                    conn = socket.socket(socket.AF_UNIX)
                    conn.connect(server.server_address)
                    conn.sendall(request)
                    response = http.client.HTTPResponse(conn)
                    response.begin()
                    self.assertEqual(response.status, 403)
                    response.read()
                    conn.close()
                self.assertEqual(calls, [])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_request_budget_is_shared_across_connections(self):
        bridge = load_bridge()
        with tempfile.TemporaryDirectory() as temp:
            calls = []
            server = bridge.make_server(str(pathlib.Path(temp) / 'broker.sock'),
                lambda path, body, headers: (calls.append(body) or (200, b'{}', 'application/json')),
                request_budget=2, byte_budget=4)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                statuses = []
                for _ in range(3):
                    conn = UnixHTTP(server.server_address)
                    conn.request('POST', '/v1/responses', body=b'{}', headers={'Content-Type': 'application/json'})
                    response = conn.getresponse()
                    statuses.append(response.status)
                    response.read()
                    conn.close()
                self.assertEqual(statuses, [200, 200, 403])
                self.assertEqual(calls, [b'{}', b'{}'])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_audit_records_admission_and_completion_even_on_upstream_error(self):
        bridge = load_bridge()
        with tempfile.TemporaryDirectory() as temp:
            def unavailable(*args):
                raise OSError('upstream unavailable')
            server = bridge.make_server(str(pathlib.Path(temp) / 'broker.sock'), unavailable,
                allowed_model='assigned-model', max_output_tokens=128)
            events = []
            server.audit = lambda event, method, path: events.append((event, method, path))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                conn = UnixHTTP(server.server_address)
                conn.request('POST', '/v1/responses', b'{"model":"assigned-model"}',
                             {'Content-Type': 'application/json'})
                response = conn.getresponse()
                self.assertEqual(response.status, 502)
                response.read()
                conn.close()
                self.assertEqual(events, [
                    ('admit', 'POST', '/v1/responses'),
                    ('upstream-502', 'POST', '/v1/responses'),
                ])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_synchronous_audit_channel_persists_each_event_before_ack(self):
        bridge = load_bridge()
        turn_path = BRIDGE_PATH.with_name('wsl-codex-turn.py')
        spec = importlib.util.spec_from_file_location('wsl_codex_turn_audit', turn_path)
        turn = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(turn)
        with tempfile.TemporaryDirectory() as temp:
            ledger = pathlib.Path(temp) / 'audit.jsonl'
            parent, child = socket.socketpair()
            writer = threading.Thread(target=turn.root_audit_stream, args=(parent, ledger), daemon=True)
            writer.start()
            server = bridge.make_server(str(pathlib.Path(temp) / 'broker.sock'),
                lambda *args: (200, b'{}', 'application/json'),
                allowed_model='assigned-model', max_output_tokens=128)
            audited = bridge.attach_audit(server, child.fileno())
            service = threading.Thread(target=server.serve_forever, daemon=True)
            service.start()
            try:
                conn = UnixHTTP(server.server_address)
                conn.request('POST', '/v1/responses', b'{"model":"assigned-model"}',
                             {'Content-Type': 'application/json'})
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
                conn.close()
                self.assertEqual([json.loads(line)['event'] for line in ledger.read_text().splitlines()],
                                 ['admit', 'upstream-200'])
                self.assertEqual(ledger.stat().st_uid, os.getuid())
                self.assertEqual(ledger.stat().st_mode & 0o777, 0o600)
            finally:
                server.shutdown()
                server.server_close()
                service.join(timeout=5)
                audited.close()
                child.close()
                writer.join(timeout=5)
                parent.close()

    def test_expired_generation_lease_refuses_api_without_upstream_call(self):
        import time
        bridge = load_bridge()
        with tempfile.TemporaryDirectory() as temp:
            calls = []
            server = bridge.make_server(str(pathlib.Path(temp) / 'broker.sock'),
                lambda path, body, headers: (calls.append(body) or (200, b'{}', 'application/json')),
                lease_seconds=1)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                time.sleep(1.1)
                conn = UnixHTTP(server.server_address)
                conn.request('POST', '/v1/responses', body=b'{}', headers={'Content-Type': 'application/json'})
                response = conn.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
                conn.close()
                self.assertEqual(calls, [])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_controller_revokes_generation_before_budget_is_spent(self):
        bridge = load_bridge()
        with tempfile.TemporaryDirectory() as temp:
            calls = []
            server = bridge.make_server(str(pathlib.Path(temp) / 'broker.sock'),
                lambda path, body, headers: (calls.append(body) or (200, b'{}', 'application/json')))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                server.revoke()
                conn = UnixHTTP(server.server_address)
                conn.request('POST', '/v1/responses', body=b'{}', headers={'Content-Type': 'application/json'})
                response = conn.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
                conn.close()
                self.assertEqual(calls, [])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_per_claim_model_and_output_ceiling_reject_worker_chosen_upgrade(self):
        import inspect
        bridge = load_bridge()
        self.assertIn('allowed_model', inspect.signature(bridge.make_server).parameters)
        with tempfile.TemporaryDirectory() as temp:
            calls = []
            server = bridge.make_server(str(pathlib.Path(temp) / 'broker.sock'),
                lambda path, body, headers: (calls.append(json.loads(body)) or (200, b'{}', 'application/json')),
                allowed_model='assigned-model', max_output_tokens=4096)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                statuses = []
                for body in ({'model': 'other-model', 'max_output_tokens': 10},
                             {'model': 'assigned-model', 'max_output_tokens': 999999},
                             {'model': 'assigned-model', 'tools': [{'type': 'web_search'}]},
                             {'model': 'assigned-model', 'url': 'https://example.com'},
                             {'model': 'assigned-model', 'tools': [{'type': 'function', 'name': 'local_tool'}]}):
                    conn = UnixHTTP(server.server_address)
                    conn.request('POST', '/v1/responses', body=json.dumps(body).encode(),
                                 headers={'Content-Type': 'application/json'})
                    response = conn.getresponse()
                    statuses.append(response.status)
                    response.read()
                    conn.close()
                self.assertEqual(statuses, [403, 403, 403, 403, 200])
                self.assertEqual(calls, [{'model': 'assigned-model',
                    'tools': [{'type': 'function', 'name': 'local_tool'}], 'max_output_tokens': 4096}])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_partial_request_flood_has_bounded_concurrent_handlers(self):
        bridge = load_bridge()
        with tempfile.TemporaryDirectory() as temp:
            server = bridge.make_server(str(pathlib.Path(temp) / 'broker.sock'),
                lambda *args: (200, b'{}', 'application/json'))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            sockets = []
            try:
                for _ in range(24):
                    conn = socket.socket(socket.AF_UNIX)
                    conn.settimeout(1)
                    try:
                        conn.connect(server.server_address)
                    except (BlockingIOError, TimeoutError, ConnectionRefusedError):
                        conn.close()  # Bounded listen backlog is also a valid rejection.
                        continue
                    sockets.append(conn)
                    try:
                        conn.sendall(b'POST /v1/responses HTTP/1.1\r\nHost: local\r\n')
                    except (BrokenPipeError, ConnectionResetError):
                        pass  # A saturated broker may reject the socket immediately.
                import time
                time.sleep(0.3)
                active = sum('process_request_thread' in t.name for t in threading.enumerate())
                self.assertLessEqual(active, 8, f'hostile partial headers occupied {active} broker threads')
            finally:
                for conn in sockets:
                    conn.close()
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_upstream_auth_file_swap_to_symlink_never_reads_replacement(self):
        from unittest.mock import patch
        bridge = load_bridge()
        with tempfile.TemporaryDirectory() as temp:
            auth = pathlib.Path(temp) / 'auth.json'
            replacement = pathlib.Path(temp) / 'replacement.json'
            auth.write_text(json.dumps({'tokens': {'access_token': 'ORIGINAL', 'account_id': 'original'}}))
            replacement.write_text(json.dumps({'tokens': {'access_token': 'EXTRACTED', 'account_id': 'replacement'}}))
            auth.chmod(0o600)
            replacement.chmod(0o600)
            original_stat = os.stat
            def swap_after_check(path, *args, **kwargs):
                info = original_stat(path, *args, **kwargs)
                if str(path) == str(auth):
                    auth.unlink()
                    auth.symlink_to(replacement)
                return info
            sent = []
            class FakeHTTPS:
                def __init__(self, *args, **kwargs): pass
                def request(self, *args, **kwargs):
                    sent.append((args, kwargs))
                def getresponse(self):
                    class Response:
                        status = 200
                        def read(self, *args): return b'{}'
                        def getheader(self, *args): return 'application/json'
                    return Response()
                def close(self): pass
            with patch.object(bridge.os, 'stat', side_effect=swap_after_check), \
                 patch.object(bridge.http.client, 'HTTPSConnection', FakeHTTPS):
                try:
                    bridge.trusted_upstream(str(auth))('/v1/responses', b'{}', {})
                except (OSError, PermissionError):
                    pass  # Fail closed on the path substitution.
            self.assertNotIn('EXTRACTED', repr(sent), 'replaced credential was used for outbound auth')
            self.assertTrue(not sent or sent[0][1]['headers']['ChatGPT-Account-ID'] == 'original')
            # Independently verify the currently installed symlink fails at open,
            # rather than relying only on the simulated lstat/read race above.
            if not auth.is_symlink():
                auth.unlink()
                auth.symlink_to(replacement)
            with self.assertRaises(OSError):
                bridge.trusted_upstream(str(auth))('/v1/responses', b'{}', {})

    def test_alternate_protocols_and_credentials_cannot_retarget_upstream(self):
        bridge = load_bridge()
        with tempfile.TemporaryDirectory() as temp:
            calls = []
            server = bridge.make_server(str(pathlib.Path(temp) / 'broker.sock'),
                lambda path, body, headers: (calls.append((path, headers)) or (200, b'{}', 'application/json')),
                allowed_model='assigned-model', max_output_tokens=128)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                for method, path in (('CONNECT', 'example.com:443'), ('POST', 'https://example.com/v1/responses'),
                                     ('POST', 'gopher://example.com/'), ('TRACE', '/v1/responses'),
                                     ('GET', '/v1/responses')):
                    conn = UnixHTTP(server.server_address)
                    try:
                        conn.request(method, path, body=b'{}', headers={'Content-Type': 'application/json',
                            'Authorization': 'Bearer stolen', 'Proxy-Authorization': 'Bearer stolen'})
                        response = conn.getresponse()
                        self.assertNotEqual(response.status, 200, (method, path))
                        response.read()
                    except (BrokenPipeError, ConnectionResetError):
                        # The bridge can reject and close before the client
                        # finishes sending an illicit request body; that is a
                        # transport denial, not an upstream pass-through.
                        pass
                    finally:
                        conn.close()
                conn = UnixHTTP(server.server_address)
                conn.request('POST', '/v1/responses', body=b'{"model":"assigned-model"}',
                    headers={'Content-Type': 'application/json', 'Authorization': 'Bearer stolen',
                             'Cookie': 'session=stolen', 'Host': 'example.com'})
                response = conn.getresponse()
                self.assertEqual(response.status, 200)
                response.read()
                conn.close()
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0][0], '/v1/responses')
                self.assertEqual(set(calls[0][1]), {'Content-Type'})
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_output_token_reservations_are_shared_and_failed_calls_still_spend_budget(self):
        bridge = load_bridge()
        with tempfile.TemporaryDirectory() as temp:
            calls = []
            server = bridge.make_server(str(pathlib.Path(temp) / 'broker.sock'),
                lambda path, body, headers: (calls.append(json.loads(body)) or (502, b'{}', 'application/json')),
                allowed_model='assigned-model', max_output_tokens=128, total_output_tokens=200)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                statuses = []
                for body in ({'model': 'assigned-model'},
                             {'model': 'assigned-model', 'max_output_tokens': 73},
                             {'model': 'assigned-model', 'max_output_tokens': 72},
                             {'model': 'assigned-model', 'max_output_tokens': 1}):
                    conn = UnixHTTP(server.server_address)
                    conn.request('POST', '/v1/responses', json.dumps(body).encode(),
                                 {'Content-Type': 'application/json'})
                    response = conn.getresponse()
                    statuses.append(response.status)
                    response.read()
                    conn.close()
                self.assertEqual(statuses, [502, 403, 502, 403])
                self.assertEqual([c['max_output_tokens'] for c in calls], [128, 72])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_revocation_during_admitted_upstream_refuses_its_late_response(self):
        bridge = load_bridge()
        with tempfile.TemporaryDirectory() as temp:
            admitted = threading.Event()
            finish = threading.Event()
            def upstream(path, body, headers):
                admitted.set()
                if not finish.wait(5):
                    raise TimeoutError('test upstream timed out')
                return 200, b'{"secret":"late"}', 'application/json'
            server = bridge.make_server(str(pathlib.Path(temp) / 'broker.sock'), upstream,
                                        allowed_model='assigned-model', max_output_tokens=128)
            service = threading.Thread(target=server.serve_forever, daemon=True)
            service.start()
            observed = []
            def client():
                conn = UnixHTTP(server.server_address)
                try:
                    conn.request('POST', '/v1/responses', b'{"model":"assigned-model"}',
                                 {'Content-Type': 'application/json'})
                    response = conn.getresponse()
                    observed.append((response.status, response.read()))
                finally:
                    conn.close()
            caller = threading.Thread(target=client)
            caller.start()
            try:
                self.assertTrue(admitted.wait(3), 'upstream never admitted request')
                server.revoke()
                finish.set()
                caller.join(5)
                self.assertFalse(caller.is_alive())
                self.assertEqual(observed, [(403, b'')])
                self.assertEqual(server.request_budget, 63)  # no refund after admission
            finally:
                finish.set()
                caller.join(5)
                server.shutdown()
                server.server_close()
                service.join(timeout=5)

    def test_untrusted_upstream_content_type_cannot_inject_response_headers(self):
        bridge = load_bridge()
        with tempfile.TemporaryDirectory() as temp:
            server = bridge.make_server(str(pathlib.Path(temp) / 'broker.sock'),
                lambda path, body, headers: (200, b'{}', 'application/json\r\nX-Leaked: credential'))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                conn = UnixHTTP(server.server_address)
                conn.request('POST', '/v1/responses', b'{}', {'Content-Type': 'application/json'})
                response = conn.getresponse()
                self.assertNotIn('X-Leaked', dict(response.getheaders()))
                response.read()
                conn.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)

    def test_broker_rejects_wrong_os_principal_before_upstream(self):
        bridge = load_bridge()
        with tempfile.TemporaryDirectory() as temp:
            calls = []
            server = bridge.make_server(str(pathlib.Path(temp) / 'broker.sock'),
                lambda path, body, headers: (calls.append(path) or (200, b'OK', 'text/plain')),
                expected_uid=os.getuid() + 1)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                conn = UnixHTTP(server.server_address)
                conn.request('POST', '/v1/responses', body=b'{}', headers={'Content-Type': 'application/json'})
                response = conn.getresponse()
                self.assertEqual(response.status, 403)
                response.read()
                conn.close()
                self.assertEqual(calls, [])
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
