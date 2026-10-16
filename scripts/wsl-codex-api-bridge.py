#!/usr/bin/env python3
"""Experimental per-claim Codex API bridge over an AF_UNIX socket.

The service runs OUTSIDE the worker namespace under the trusted controller;
only the single Responses endpoint is accepted. No auth file is mounted in the
worker. This does not enable production Codex dispatch or attest an API turn.
"""
import argparse
import base64
import http.client
import json
import os
import pathlib
import socket
import socketserver
import stat
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler

MAX_BODY = 2 * 1024 * 1024


class Bridge(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, path, upstream, expected_uid, claim, generation, role, request_budget, byte_budget):
        if not 1 <= request_budget <= 256 or not 1 <= byte_budget <= 64 * MAX_BODY:
            raise ValueError('bridge requires bounded per-claim budgets')
        self.upstream = upstream
        self.expected_uid = expected_uid
        self.claim = claim
        self.generation = generation
        self.role = role
        self.request_budget = request_budget
        self.byte_budget = byte_budget
        self.budget_lock = threading.Lock()
        super().__init__(path, Request)

    def reserve_request(self, size):
        with self.budget_lock:
            if self.request_budget < 1 or self.byte_budget < size:
                return False
            self.request_budget -= 1
            self.byte_budget -= size
            return True


class Request(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass  # Never log prompts, credential-bearing headers, or arbitrary paths.

    def refuse(self):
        audit = getattr(self.server, 'audit', None)
        if audit:
            label = self.path if self.path in ('/v1/responses', '/v1/models') else '<other>'
            audit('deny', self.command if self.command in ('GET', 'POST', 'CONNECT') else '<other>', label)
        self.send_response(403)
        self.send_header('Content-Length', '0')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.close_connection = True

    def do_POST(self):
        try:
            _, uid, _ = struct.unpack('3i', self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        except (OSError, struct.error):
            return self.refuse()
        if self.server.expected_uid is not None and uid != self.server.expected_uid:
            return self.refuse()
        if self.path != '/v1/responses':
            return self.refuse()
        # BaseHTTPRequestHandler chooses the first duplicate header; never let
        # an ambiguous framing/authority reach the privileged upstream.
        for name in ('Content-Length', 'Content-Type', 'Host', 'Transfer-Encoding'):
            if len(self.headers.get_all(name, [])) > 1:
                return self.refuse()
        if self.headers.get('Transfer-Encoding') or self.headers.get('Proxy-Authorization'):
            return self.refuse()
        try:
            length = int(self.headers.get('Content-Length', '-1'))
        except ValueError:
            return self.refuse()
        if not 0 < length <= MAX_BODY or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.refuse()
        body = self.rfile.read(length)
        if len(body) != length:
            return self.refuse()
        try:
            if not isinstance(json.loads(body), dict):
                return self.refuse()
        except (ValueError, UnicodeDecodeError):
            return self.refuse()
        if not self.server.reserve_request(length):
            return self.refuse()
        # No Authorization, Host, Cookie, forwarding, or caller-selected destination.
        headers = {'Content-Type': 'application/json'}
        if self.headers.get('Accept') == 'text/event-stream':
            headers['Accept'] = 'text/event-stream'
        try:
            status, payload, content_type = self.server.upstream('/v1/responses', body, headers)
        except Exception:
            status, payload, content_type = 502, b'', 'application/json'
        audit = getattr(self.server, 'audit', None)
        if audit:
            audit(f'upstream-{status}', 'POST', '/v1/responses')
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(payload)
        self.close_connection = True

    def do_GET(self):
        if self.path != '/internal/identity' or self.server.claim is None:
            return self.refuse()
        try:
            _, uid, _ = struct.unpack('3i', self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
        except (OSError, struct.error):
            return self.refuse()
        if uid != 0:
            return self.refuse()
        body = json.dumps({'claim': self.server.claim, 'generation': self.server.generation,
                           'role': self.server.role, 'uid': self.server.expected_uid}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True
    def do_HEAD(self): self.refuse()
    def do_PUT(self): self.refuse()
    def do_DELETE(self): self.refuse()
    def do_CONNECT(self): self.refuse()
    def do_OPTIONS(self): self.refuse()
    def do_PATCH(self): self.refuse()


def make_server(path, upstream, expected_uid=None, claim=None, generation=None, role=None,
                request_budget=64, byte_budget=8 * MAX_BODY):
    if os.path.lexists(path):
        raise FileExistsError('existing bridge path refused')
    return Bridge(path, upstream, expected_uid, claim, generation, role,
                  request_budget, byte_budget)


def trusted_upstream(auth_path):
    """Read the original WSL login only in this trusted process, per request."""
    def send(path, body, headers):
        info = os.stat(auth_path, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise PermissionError('invalid private auth file')
        auth = json.loads(pathlib.Path(auth_path).read_text())
        tokens = auth.get('tokens') or {}
        token = tokens.get('access_token')
        account = tokens.get('account_id')
        if not isinstance(token, str) or not token or not isinstance(account, str) or not account:
            raise PermissionError('ChatGPT auth unavailable')
        # Do not transmit a stale access token. No refresh token is ever sent to the worker.
        parts = token.split('.')
        if len(parts) == 3:
            claims = json.loads(base64.urlsafe_b64decode(parts[1] + '=' * (-len(parts[1]) % 4)))
            if claims.get('exp', 0) <= time.time() + 60:
                raise PermissionError('ChatGPT access token expired')
        conn = http.client.HTTPSConnection('chatgpt.com', timeout=45)
        try:
            # A ChatGPT device-login token is scoped to the Codex backend,
            # not to the API-key endpoint at api.openai.com.
            conn.request('POST', '/backend-api/codex/responses', body=body,
                         headers={**headers, 'Authorization': 'Bearer ' + token,
                                  'ChatGPT-Account-ID': account})
            response = conn.getresponse()
            payload = response.read(8 * MAX_BODY + 1)
            if len(payload) > 8 * MAX_BODY:
                raise ValueError('upstream response exceeds cap')
            # Nothing from upstream headers (cookies, redirects, auth) escapes to the worker.
            return response.status, payload, response.getheader('Content-Type', 'application/json')
        finally:
            conn.close()
    return send


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--socket', required=True)
    parser.add_argument('--auth', required=True)
    parser.add_argument('--worker-gid', type=int, required=True)
    parser.add_argument('--worker-uid', type=int, required=True)
    parser.add_argument('--claim', required=True)
    parser.add_argument('--generation', required=True)
    args = parser.parse_args()
    server = make_server(args.socket, trusted_upstream(args.auth), expected_uid=args.worker_uid,
                         claim=args.claim, generation=args.generation, role='worker')
    try:
        os.chown(args.socket, os.getuid(), args.worker_gid)
        os.chmod(args.socket, 0o660)
        server.serve_forever()
    finally:
        server.server_close()
        os.unlink(args.socket)


if __name__ == '__main__':
    main()
