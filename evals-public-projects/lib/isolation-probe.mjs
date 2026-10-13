#!/usr/bin/env node
/**
 * The isolation preflight's probe: runs inside an agent session's sandbox
 * (bound read-only at PROBE_SCRIPT, see lib/isolation.mjs), exactly where
 * and as a session would, and reports what it can reach. It reads a JSON
 * spec on stdin and prints `{ checks: [{ id, ok, detail }] }`. Every check
 * passes only when the boundary holds; anything it cannot establish fails.
 *
 * Self-contained (no imports from the suite): nothing else of it is bound.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import dns from 'node:dns';
import net from 'node:net';
import { join } from 'node:path';

const spec = JSON.parse(readFileSync(0, 'utf8'));
const checks = [];
const check = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });
const code = (fn) => {
  try {
    fn();
    return 'ok';
  } catch (error) {
    return error.code ?? error.message;
  }
};

// ---- the file system: forbidden roots absent, skeleton directories empty but for bound paths.
for (const path of spec.forbidden ?? []) {
  const c = code(() => statSync(path));
  check(`forbidden:${path}`, c === 'ENOENT' || c === 'EACCES', c === 'ok' ? 'visible inside the sandbox' : c);
}
for (const { path, allowed } of spec.listing ?? []) {
  let names = null;
  const c = code(() => {
    names = readdirSync(path);
  });
  const extra = (names ?? []).filter((n) => !allowed.includes(n));
  check(`listing:${path}`, c === 'ENOENT' || (c === 'ok' && extra.length === 0), c === 'ok' ? (extra.length ? `also holds ${extra.slice(0, 5).join(', ')}` : `only ${names.join(', ') || 'nothing'}`) : c);
}
for (const path of spec.readonly ?? []) {
  const file = join(path, `.bench-probe-${process.pid}`);
  const c = code(() => writeFileSync(file, 'x'));
  if (c === 'ok') code(() => unlinkSync(file));
  check(`readonly:${path}`, ['EROFS', 'EACCES', 'EPERM'].includes(c), c === 'ok' ? 'writable from inside the sandbox' : c);
}
for (const path of spec.writable ?? []) {
  const file = join(path, `.bench-probe-${process.pid}`);
  const c = code(() => {
    writeFileSync(file, 'x');
    unlinkSync(file);
  });
  check(`writable:${path}`, c === 'ok', c);
}

// ---- the kernel: no capabilities, no new privileges, a seccomp filter; no nested user namespaces.
const status = readFileSync('/proc/self/status', 'utf8');
const field = (name) => new RegExp(`^${name}:\\s*(\\S+)`, 'm').exec(status)?.[1] ?? null;
check('capabilities', /^0+$/.test(field('CapEff') ?? 'x') && /^0+$/.test(field('CapPrm') ?? 'x'), `CapEff ${field('CapEff')}, CapPrm ${field('CapPrm')}`);
check('no-new-privileges', field('NoNewPrivs') === '1', `NoNewPrivs ${field('NoNewPrivs')}`);
check('seccomp', field('Seccomp') === '2', `Seccomp ${field('Seccomp')}`);
{
  const c = code(() => execFileSync('/usr/bin/unshare', ['-U', '/usr/bin/true'], { stdio: 'ignore' }));
  check('no-user-namespaces', c !== 'ok', c === 'ok' ? 'a nested user namespace could be created' : c === 'ENOENT' ? 'unshare is not installed (bwrap --disable-userns is in the profile)' : `refused (${c})`);
}
{
  let out = 'no python3';
  try {
    out = execFileSync('/usr/bin/python3', ['-c', 'import socket\ntry:\n  socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM); print("allowed")\nexcept OSError as e: print("denied")'], { encoding: 'utf8' }).trim();
  } catch {
    out = 'no python3';
  }
  check('vsock', out === 'denied', out === 'denied' ? 'socket(AF_VSOCK) is refused' : out === 'allowed' ? 'an AF_VSOCK socket could be created (it reaches the WSL host past the network namespace)' : 'cannot check AF_VSOCK without python3: fail closed');
}

// ---- WSL interop: Windows executables cannot run, its sockets and drives are absent.
for (const path of ['/proc/sys/fs/binfmt_misc/WSLInterop', '/run/WSL', '/mnt/c', '/mnt/wsl', '/init']) {
  const c = code(() => statSync(path));
  check(`interop:${path}`, c === 'ENOENT' || c === 'EACCES', c === 'ok' ? 'present inside the sandbox' : c);
}
check('interop:env', !('WSL_INTEROP' in process.env) && !('WSLENV' in process.env), 'no WSL interop variables');
{
  const exe = join(spec.writable?.[0] ?? '/tmp', `.bench-probe-${process.pid}.exe`);
  const written = code(() => {
    writeFileSync(exe, Buffer.concat([Buffer.from('MZ'), Buffer.alloc(254)]));
    chmodSync(exe, 0o755);
  });
  const c = written === 'ok' ? code(() => execFileSync(exe, [], { stdio: 'ignore', timeout: 5000 })) : null;
  code(() => unlinkSync(exe));
  check('interop:exec', written === 'ok' && c !== 'ok', written !== 'ok' ? `cannot place a Windows executable to try (${written})` : c === 'ok' ? 'a Windows executable ran' : `refused (${c})`);
}

// ---- the JVM: where a session's java (first on its PATH) puts user.home, which Maven and its wrapper read.
if (spec.java) {
  // The settings go to stderr, with `-version`; the session's environment (JAVA_TOOL_OPTIONS) is inherited.
  const r = spawnSync('java', ['-XshowSettings:properties', '-version'], { encoding: 'utf8', timeout: 60_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const home = /^\s*user\.home = (.*)$/m.exec(out)?.[1] ?? null;
  check('java:user.home', home === spec.java.home, home === null ? `no user.home from java: ${r.error?.code ?? out.trim().split('\n')[0]?.slice(0, 200)}` : `user.home = ${home}`);
}

// ---- a process that tries to outlive the sandbox (the driver looks for it afterwards).
if (spec.lingerSeconds) spawn('/usr/bin/sleep', [String(spec.lingerSeconds)], { detached: true, stdio: 'ignore' }).unref();

// ---- the network: nothing direct, no resolver; the proxy allows exactly its allowlist.
const direct = () =>
  new Promise((done) => {
    const s = net.connect({ host: spec.external?.host ?? '1.1.1.1', port: spec.external?.port ?? 443 });
    const t = setTimeout(() => {
      s.destroy();
      done('timeout');
    }, 3000);
    s.on('connect', () => {
      clearTimeout(t);
      s.destroy();
      done('CONNECTED');
    });
    s.on('error', (e) => {
      clearTimeout(t);
      done(e.code ?? e.message);
    });
  });
const lookup = () => new Promise((done) => dns.lookup(spec.dns ?? 'api.anthropic.com', (e) => done(e ? e.code ?? 'error' : 'RESOLVED')));
const connect = (target) =>
  new Promise((done) => {
    const s = net.connect({ host: '127.0.0.1', port: spec.proxy.port });
    let got = '';
    const t = setTimeout(() => {
      s.destroy();
      done(`no answer (${got.slice(0, 40)})`);
    }, 10_000);
    s.on('connect', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.on('data', (d) => {
      got += d;
      const line = got.split('\r\n')[0];
      if (got.includes('\r\n')) {
        clearTimeout(t);
        s.destroy();
        done(line);
      }
    });
    s.on('error', (e) => {
      clearTimeout(t);
      done(e.code ?? e.message);
    });
  });

const net1 = await direct();
check('network:direct', net1 !== 'CONNECTED', net1 === 'CONNECTED' ? `reached ${spec.external?.host ?? '1.1.1.1'} directly` : net1);
const resolved = await lookup();
check('network:dns', resolved !== 'RESOLVED', resolved === 'RESOLVED' ? 'names resolve inside the sandbox' : resolved);
if (spec.proxy) {
  const allowedLine = await connect(spec.proxy.allowed);
  check('proxy:allowed', / 200 /.test(allowedLine), `CONNECT ${spec.proxy.allowed}: ${allowedLine}`);
  const deniedLine = await connect(spec.proxy.denied);
  check('proxy:denied', / 403 /.test(deniedLine), `CONNECT ${spec.proxy.denied}: ${deniedLine}`);
}
process.stdout.write(`${JSON.stringify({ checks })}\n`);
process.exit(0);
