#!/usr/bin/env node
/**
 * The in-sandbox launcher of an agent session (bound read-only at
 * INIT_SCRIPT, see lib/sandbox.mjs). The sandbox's network namespace has
 * only loopback: this forwards 127.0.0.1:PROXY_PORT to the model proxy's
 * Unix socket, bound in at PROXY_SOCKET, then runs the command after `--`
 * with the launcher's stdio and exits with its status. Sessions reach the
 * model API through HTTPS_PROXY=http://127.0.0.1:PROXY_PORT; the proxy
 * outside decides what is allowed.
 *
 *   node /run/bench/init.mjs -- <command> [args...]
 *
 * Self-contained (no imports from the suite): nothing else of it is bound.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { constants } from 'node:os';

const PROXY_SOCKET = '/run/bench/proxy.sock';
const PROXY_PORT = 3128;

const sep = process.argv.indexOf('--');
const argv = sep >= 0 ? process.argv.slice(sep + 1) : [];
if (argv.length === 0) {
  process.stderr.write('sandbox-init: usage: init.mjs -- <command> [args...]\n');
  process.exit(2);
}

const server = net.createServer((client) => {
  const upstream = net.connect(PROXY_SOCKET);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close);
  upstream.on('error', close);
  client.on('close', close);
  upstream.on('close', close);
  client.pipe(upstream);
  upstream.pipe(client);
});

server.on('error', (error) => {
  process.stderr.write(`sandbox-init: cannot listen on 127.0.0.1:${PROXY_PORT}: ${error.message}\n`);
  process.exit(125);
});

server.listen(PROXY_PORT, '127.0.0.1', () => {
  const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' });
  child.on('error', (error) => {
    process.stderr.write(`sandbox-init: cannot start ${argv[0]}: ${error.message}\n`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => {
    process.exit(code ?? 128 + (constants.signals[signal] ?? 0));
  });
});
