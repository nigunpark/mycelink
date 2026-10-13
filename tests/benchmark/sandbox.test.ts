/**
 * The isolation boundary (bubblewrap). The profile and the seccomp filter
 * are checked everywhere; the sandbox itself where it can run (Linux with
 * bubblewrap — WSL here): only bound paths exist inside, there is no
 * network but loopback, AF_VSOCK is refused, and nothing outlives it.
 * Elsewhere the boundary is unavailable, and says why.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
// @ts-expect-error -- plain ESM module without type declarations
import { bwrapArgs, detectSandbox, processesIn, runSync, sandboxInit, seccompProgram, unconfined } from '../../evals-public-projects/lib/sandbox.mjs';

afterAll(() => cleanupTmpRoots());

const SYS = [{ name: 'bin', link: 'usr/bin' }, { name: 'lib', link: 'usr/lib' }, { name: 'lib64', link: undefined }];

/** A classic-BPF interpreter for the instructions the filter uses, over a seccomp_data record. */
function runFilter(program: Buffer, { arch, nr, arg0 = 0 }: { arch: number; nr: number; arg0?: number }): number {
  const data = Buffer.alloc(64);
  data.writeUInt32LE(nr, 0);
  data.writeUInt32LE(arch >>> 0, 4);
  data.writeUInt32LE(arg0 >>> 0, 16);
  let pc = 0;
  let a = 0;
  for (let steps = 0; steps < 1000; steps++) {
    const code = program.readUInt16LE(pc * 8);
    const jt = program.readUInt8(pc * 8 + 2);
    const jf = program.readUInt8(pc * 8 + 3);
    const k = program.readUInt32LE(pc * 8 + 4);
    if (code === 0x20) a = data.readUInt32LE(k);
    else if (code === 0x15) {
      pc += a === k ? jt : jf;
    } else if (code === 0x35) {
      pc += a >= k ? jt : jf;
    } else if (code === 0x06) return k;
    else throw new Error(`unexpected BPF code ${code}`);
    pc += 1;
  }
  throw new Error('filter did not return');
}

describe('the seccomp filter', () => {
  const X86_64 = 0xc000003e;
  const ALLOW = 0x7fff0000;
  const EPERM = 0x00050001;
  const program = seccompProgram();
  it('refuses AF_VSOCK sockets and io_uring, and allows every other socket and call', () => {
    expect(runFilter(program, { arch: X86_64, nr: 41, arg0: 40 })).toBe(EPERM); // socket(AF_VSOCK)
    expect(runFilter(program, { arch: X86_64, nr: 425 })).toBe(EPERM); // io_uring_setup
    expect(runFilter(program, { arch: X86_64, nr: 41, arg0: 2 })).toBe(ALLOW); // socket(AF_INET)
    expect(runFilter(program, { arch: X86_64, nr: 41, arg0: 1 })).toBe(ALLOW); // socket(AF_UNIX)
    expect(runFilter(program, { arch: X86_64, nr: 0 })).toBe(ALLOW); // read
    expect(runFilter(program, { arch: X86_64, nr: 59 })).toBe(ALLOW); // execve
  });
  it('refuses x32 calls and any other architecture outright', () => {
    expect(runFilter(program, { arch: X86_64, nr: 0x40000000 | 41, arg0: 2 })).toBe(EPERM);
    expect(runFilter(program, { arch: 0xc00000b7, nr: 198, arg0: 40 })).toBe(EPERM); // aarch64
  });
});

describe('the sandbox profile', () => {
  const args: string[] = bwrapArgs({
    binds: [{ path: '/tmp/run/workspace', rw: true }, { path: '/opt/toolchain' }],
    env: { PATH: '/usr/bin', HOME: '/tmp/run/home' },
    cwd: '/tmp/run/workspace',
    proxySocket: '/tmp/run/proxy.sock',
    seccompFd: 3,
    system: SYS,
  });
  const pairs = (flag: string) => args.flatMap((a, i) => (a === flag ? [[args[i + 1], args[i + 2]]] : []));
  it('unshares every namespace, drops capabilities and nested user namespaces, and dies with its parent', () => {
    expect(args.slice(0, 7)).toEqual(['--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session', '--cap-drop', 'ALL']);
    expect(args).not.toContain('--share-net');
    expect(args).toContain('--clearenv');
    expect(args.at(-1)).toBe('--');
  });
  it('binds only the system read-only and the named paths, never the host root', () => {
    expect(pairs('--ro-bind')).toEqual([
      ['/usr', '/usr'],
      ['/etc', '/etc'],
      ['/opt/toolchain', '/opt/toolchain'],
    ]);
    expect(pairs('--bind')).toEqual([
      ['/tmp/run/workspace', '/tmp/run/workspace'],
      ['/tmp/run/proxy.sock', '/run/bench/proxy.sock'],
    ]);
    expect(pairs('--symlink')).toEqual([
      ['usr/bin', '/bin'],
      ['usr/lib', '/lib'],
    ]);
    expect(args.filter((a, i) => a === '/' && ['--bind', '--ro-bind', '--dev-bind'].includes(args[i - 1]))).toEqual([]);
    // Private, empty /tmp before the binds that live under it.
    expect(args.indexOf('/tmp')).toBeLessThan(args.indexOf('/tmp/run/workspace'));
    expect(pairs('--setenv')).toEqual([
      ['PATH', '/usr/bin'],
      ['HOME', '/tmp/run/home'],
    ]);
    expect(args[args.indexOf('--seccomp') + 1]).toBe('3');
  });
});

const host = detectSandbox();

describe('the sandbox on this host', () => {
  it('is available only on Linux with a working bubblewrap, and says why not otherwise', () => {
    expect(detectSandbox({ platform: 'win32' })).toMatchObject({ available: false, reason: expect.stringMatching(/Linux with bubblewrap/) });
    expect(detectSandbox({ platform: 'darwin' })).toMatchObject({ available: false });
    if (process.platform !== 'linux') expect(host.available).toBe(false);
  });

  it('runs a command unconfined only as an explicit, unenforced stand-in', () => {
    const none = unconfined('test host');
    const r = runSync(none, { argv: [process.execPath, '-e', 'console.log("ran")'], env: { PATH: process.env.PATH }, cwd: makeTmpDir('bench-sbx-') }, { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('ran');
    expect(none).toMatchObject({ kind: 'none', enforced: false });
  });

  it.runIf(host.available)('hides every path it does not bind, has no network but loopback, refuses AF_VSOCK, and leaves nothing behind', () => {
    const sandbox = { kind: 'bubblewrap', enforced: true, bwrap: host.bwrap, version: host.version };
    const work = makeTmpDir('bench-sbx-work-');
    const secret = join(makeTmpDir('bench-sbx-secret-'), 'hidden.txt');
    writeFileSync(secret, 'evaluator content\n');
    const info = join(makeTmpDir('bench-sbx-info-'), 'info.json');
    const probe = `
const fs = require('fs'), net = require('net'), cp = require('child_process'), dns = require('dns');
const out = { secret: null, home: null, mnt: null, work: null };
for (const [k, p] of [['secret', ${JSON.stringify(secret)}], ['home', ${JSON.stringify(homedir())}], ['mnt', '/mnt'], ['work', ${JSON.stringify(work)}]]) { try { fs.statSync(p); out[k] = 'visible'; } catch (e) { out[k] = e.code; } }
try { out.vsock = cp.execFileSync('/usr/bin/python3', ['-c', 'import socket\\ntry:\\n  socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM); print("allowed")\\nexcept OSError as e: print("denied")'], { encoding: 'utf8' }).trim(); } catch { out.vsock = 'no python3'; }
cp.spawn('sleep', ['300'], { detached: true, stdio: 'ignore' }).unref();
const s = net.createServer((c) => c.end('lo')).listen(0, '127.0.0.1', () => {
  net.connect(s.address().port, '127.0.0.1').on('data', (d) => { out.loopback = String(d);
    const ext = net.connect({ host: '1.1.1.1', port: 443, timeout: 3000 });
    ext.on('connect', () => { out.net = 'CONNECTED'; finish(); }).on('error', (e) => { out.net = e.code; finish(); }).on('timeout', () => { out.net = 'timeout'; finish(); });
  });
});
function finish() { dns.lookup('registry.npmjs.org', (e) => { out.dns = e ? e.code : 'RESOLVED'; console.log(JSON.stringify(out)); process.exit(0); }); }`;
    const r = runSync(sandbox, { argv: [process.execPath, '-e', probe], env: { PATH: '/usr/bin:/bin' }, cwd: work, binds: [{ path: work, rw: true }, { path: process.execPath }], infoPath: info }, { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, String(r.stderr)).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out).toMatchObject({ secret: 'ENOENT', mnt: 'ENOENT', work: 'visible', loopback: 'lo', vsock: 'denied' });
    expect(['ENOENT', 'visible']).toContain(out.home); // a bound path under it may create its components, nothing else
    expect(['ENETUNREACH', 'EHOSTUNREACH', 'ECONNREFUSED', 'timeout']).toContain(out.net);
    expect(out.net).not.toBe('CONNECTED');
    expect(out.dns).not.toBe('RESOLVED');
    // The sandbox's PID namespace is gone with its PID 1: the detached sleeper did not survive.
    const init = sandboxInit(info);
    expect(init?.pid).toBeGreaterThan(0);
    // The kernel kills the namespace's members when PID 1 exits; under load the killed sleeper can be listed for a
    // moment. Watch (never kill) for at most the reaper's grace period, then nothing may be left.
    const left = () => [...processesIn(init?.ns ?? null), ...spawnSync('pgrep', ['-f', '^sleep 300$'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)];
    for (const deadline = Date.now() + 2000; left().length > 0 && Date.now() < deadline; ) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    expect(processesIn(init?.ns ?? null)).toEqual([]);
    expect(spawnSync('pgrep', ['-f', '^sleep 300$'], { encoding: 'utf8' }).stdout.trim()).toBe('');
  });
});

