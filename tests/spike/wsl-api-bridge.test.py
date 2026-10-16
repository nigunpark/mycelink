"""Allowlist tests for the Unix-socket credential broker. No real API calls."""
import http.client
import importlib.util
import json
import os
import pathlib
import socket
import tempfile
import threading
import unittest

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
