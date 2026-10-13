#!/usr/bin/env node
/**
 * The model proxy: the only way out of an agent session's sandbox.
 *
 * Inside the sandbox there is no network but loopback; the in-sandbox
 * launcher (lib/sandbox-init.mjs) forwards 127.0.0.1:PROXY_PORT to a Unix
 * socket bound in from outside, where this proxy listens — as its own
 * process, so that nothing the driver does synchronously ever stalls a
 * session's model traffic. It accepts HTTP CONNECT to exactly the
 * allowlisted `host:port` targets (by default the model API,
 * api.anthropic.com:443) and answers anything else — another host or
 * port, a plain HTTP request, a malformed request — with 403. Each
 * decision is logged (one JSON line, written before the client gets its
 * answer: target, allowed or not), and each connection again when it
 * closes (status, bytes each way, duration).
 *
 *   node lib/model-proxy.mjs --socket <path> --log <file> [--allow <host:port>]...
 *
 * prints {"ready":true,...} on stdout once it listens, and stops on SIGTERM.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

/** The model API every session needs; the run-arm options add others (recorded). */
export const DEFAULT_ALLOW = ['api.anthropic.com:443'];

const MAX_HEAD = 16 * 1024;

/** `host:port` of a CONNECT request head, or null when it is not exactly one. */
export function connectTarget(head) {
  const line = head.split('\r\n')[0];
  const m = /^CONNECT ([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]+\]):(\d{1,5}) HTTP\/1\.[01]$/.exec(line);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: m[1].toLowerCase(), port };
}

/** Is `target` exactly one of the allowlisted `host:port` entries? */
export function allowed(target, allow) {
  return target !== null && allow.some((a) => a.toLowerCase() === `${target.host}:${target.port}`);
}

/** Serve on `socket` until closed; returns the net.Server. */
export function serveProxy({ socket, log, allow = DEFAULT_ALLOW }) {
  const record = (entry) => appendFileSync(log, `${JSON.stringify(entry)}\n`);
  const server = net.createServer((client) => {
    const started = Date.now();
    let head = Buffer.alloc(0);
    const entry = { event: 'closed', at: new Date().toISOString(), target: null, allowed: false, status: null, up: 0, down: 0, ms: 0 };
    const done = () => {
      if (entry.ms) return;
      entry.ms = Date.now() - started || 1;
      record(entry);
    };
    const decide = (target, ok) => {
      entry.target = target;
      entry.allowed = ok;
      record({ event: 'request', at: new Date().toISOString(), target, allowed: ok });
    };
    const refuse = (status, why) => {
      entry.status = status;
      entry.detail = why;
      client.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Request'}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      done();
    };
    client.on('error', done);
    client.on('close', done);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > MAX_HEAD) {
          client.off('data', onData);
          refuse(400, 'request head too large');
        }
        return;
      }
      client.off('data', onData);
      const text = head.subarray(0, end).toString('latin1');
      const target = connectTarget(text);
      const ok = allowed(target, allow);
      decide(target ? `${target.host}:${target.port}` : text.split('\r\n')[0].slice(0, 200), ok);
      if (!ok) {
        refuse(403, target ? 'not allowlisted' : 'not a CONNECT request');
        return;
      }
      const upstream = net.connect({ host: target.host, port: target.port });
      upstream.on('connect', () => {
        entry.status = 200;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const rest = head.subarray(end + 4);
        if (rest.length) {
          entry.up += rest.length;
          upstream.write(rest);
        }
        client.on('data', (d) => {
          entry.up += d.length;
        });
        upstream.on('data', (d) => {
          entry.down += d.length;
        });
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', (error) => {
        if (entry.status === null) {
          entry.status = 502;
          entry.detail = error.code ?? error.message;
          client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        } else client.destroy();
        done();
      });
      // pipe() ends each side when the other ends; a side that goes away takes the tunnel down after flushing.
      upstream.on('close', () => client.end());
      client.on('close', () => upstream.destroy());
    };
    client.on('data', onData);
  });
  server.listen(socket);
  return server;
}

/**
 * Start the proxy as a child process; resolves to `{ socket, log, allow,
 * stop() }` once it listens.
 */
export function startModelProxy({ socket, log, allow = DEFAULT_ALLOW, node = process.execPath }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(node, [fileURLToPath(import.meta.url), '--socket', socket, '--log', log, ...allow.flatMap((a) => ['--allow', a])], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('\n')) {
        try {
          const ready = JSON.parse(out.split('\n')[0]);
          if (!ready.ready) throw new Error('not ready');
          resolvePromise({
            socket,
            log,
            allow,
            pid: child.pid,
            stop: () =>
              new Promise((r) => {
                if (child.exitCode !== null) return r();
                child.once('exit', () => r());
                child.kill('SIGTERM');
              }),
          });
        } catch (error) {
          reject(new Error(`the model proxy did not start: ${out}${err}`));
        }
      }
    });
    child.on('exit', (code) => reject(new Error(`the model proxy exited (${code}): ${err.trim().slice(0, 300)}`)));
    child.on('error', reject);
  });
}

/** Summary of a proxy log: the requests allowed and denied, by target. */
export function proxySummary(lines) {
  const entries = lines
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.event === 'request');
  const count = (list) => Object.fromEntries([...new Set(list.map((e) => e.target))].sort().map((t) => [t, list.filter((e) => e.target === t).length]));
  return { connections: entries.length, allowed: count(entries.filter((e) => e.allowed)), denied: count(entries.filter((e) => !e.allowed)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const value = (name) => args[args.indexOf(name) + 1];
  const allow = args.flatMap((a, i) => (a === '--allow' ? [args[i + 1]] : []));
  const socket = value('--socket');
  const log = value('--log');
  rmSync(socket, { force: true });
  const server = serveProxy({ socket, log, allow: allow.length ? allow : DEFAULT_ALLOW });
  server.on('listening', () => process.stdout.write(`${JSON.stringify({ ready: true, socket, allow: allow.length ? allow : DEFAULT_ALLOW, pid: process.pid })}\n`));
  server.on('error', (error) => {
    process.stderr.write(`model proxy: ${error.message}\n`);
    process.exit(2);
  });
  // The sessions are over when the proxy is stopped: open tunnels go with it (every entry is already logged or closing).
  process.on('SIGTERM', () => process.exit(0));
}
