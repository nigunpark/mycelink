/**
 * The isolation boundary: bubblewrap on Linux.
 *
 * Every agent session, and every run of delivered code (trusted test runs,
 * the Mycelink CLI on an agent's workspace, fault replays), runs in a fresh
 * bubblewrap sandbox: new user, mount, PID, IPC, UTS, cgroup and network
 * namespaces; no capabilities; no nested user namespaces; the system (/usr,
 * /etc) read-only; private /tmp, /var/tmp and /dev/shm; and nothing else
 * but the paths a profile binds — read-only unless it says otherwise, at
 * the same path as on the host (so recorded paths stay meaningful). The
 * evaluator store, the caches, the suite, the development checkout, the
 * operator's home and the Windows drives simply do not exist inside.
 *
 * The network namespace has only loopback. Agent sessions reach the model
 * API through an allowlisting CONNECT proxy outside (lib/model-proxy.mjs),
 * over a Unix socket bound in; trusted runs get no network at all. A
 * seccomp filter refuses AF_VSOCK sockets (on WSL they reach the Windows
 * host past the network namespace) and io_uring (which could open them).
 * The sandbox's PID 1 is the command; when it ends the kernel kills every
 * process left in the namespace, and survivors are looked for anyway.
 *
 * `unconfined(reason)` stands in on hosts without bubblewrap, for the
 * harness's own tests only: it runs commands as they are and every record
 * says `enforced: false`. The tools (run-arm, verify-run, qualify, cache,
 * selftest) never use it: they require the sandbox and fail closed.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { sha256Hex } from './hash.mjs';

/** Where a profile's model proxy socket appears inside the sandbox. */
export const PROXY_SOCKET = '/run/bench/proxy.sock';
/** Where the in-sandbox launcher (lib/sandbox-init.mjs) appears inside the sandbox. */
export const INIT_SCRIPT = '/run/bench/init.mjs';
/** The loopback port the in-sandbox launcher forwards to the proxy socket. */
export const PROXY_PORT = 3128;

const SYSTEM_LINKS = ['bin', 'lib', 'lib32', 'lib64', 'libx32', 'sbin'];

/**
 * The seccomp program (classic BPF, x86_64): socket(AF_VSOCK, ...) and
 * io_uring_setup fail with EPERM, x32 system calls and any other
 * architecture are refused, everything else is allowed.
 */
export function seccompProgram() {
  const AUDIT_ARCH_X86_64 = 0xc000003e;
  const ins = [
    [0x20, 0, 0, 4], // A = arch
    [0x15, 0, 7, AUDIT_ARCH_X86_64], // not x86_64 -> deny
    [0x20, 0, 0, 0], // A = syscall number
    [0x35, 5, 0, 0x40000000], // x32 ABI -> deny
    [0x15, 4, 0, 425], // io_uring_setup -> deny
    [0x15, 0, 2, 41], // socket ? next : allow
    [0x20, 0, 0, 16], // A = domain (args[0], low 32 bits)
    [0x15, 1, 0, 40], // AF_VSOCK -> deny
    [0x06, 0, 0, 0x7fff0000], // allow
    [0x06, 0, 0, 0x00050001], // deny: errno EPERM
  ];
  const buf = Buffer.alloc(ins.length * 8);
  ins.forEach(([code, jt, jf, k], i) => {
    buf.writeUInt16LE(code, i * 8);
    buf.writeUInt8(jt, i * 8 + 2);
    buf.writeUInt8(jf, i * 8 + 3);
    buf.writeUInt32LE(k >>> 0, i * 8 + 4);
  });
  return buf;
}

/**
 * bwrap arguments (up to and including `--`) for one confined command.
 * `binds` are `{ path, dest?, rw? }`; `proxySocket` a host Unix socket
 * bound at PROXY_SOCKET; `fds` the descriptor numbers the child gets for
 * the seccomp program and the info record.
 */
export function bwrapArgs({ binds = [], env = {}, cwd, proxySocket = null, init = null, seccompFd = null, infoFd = null, system = SYSTEM_LINKS.map((name) => ({ name, link: hostLink(`/${name}`) })) }) {
  const args = ['--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session', '--cap-drop', 'ALL'];
  args.push('--ro-bind', '/usr', '/usr');
  for (const s of system) {
    if (s.link === undefined) continue;
    if (s.link === null) args.push('--ro-bind', `/${s.name}`, `/${s.name}`);
    else args.push('--symlink', s.link, `/${s.name}`);
  }
  args.push('--ro-bind', '/etc', '/etc', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/dev/shm', '--tmpfs', '/tmp', '--tmpfs', '/var/tmp');
  for (const b of binds) args.push(b.rw ? '--bind' : '--ro-bind', b.path, b.dest ?? b.path);
  if (proxySocket) args.push('--bind', proxySocket, PROXY_SOCKET);
  if (init) args.push('--ro-bind', init, INIT_SCRIPT);
  if (seccompFd !== null) args.push('--seccomp', String(seccompFd));
  if (infoFd !== null) args.push('--info-fd', String(infoFd));
  if (cwd) args.push('--chdir', cwd);
  args.push('--clearenv');
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== null) args.push('--setenv', k, String(v));
  args.push('--');
  return args;
}

/** How a top-level system path looks on this host: a symlink target, null for a directory, undefined when absent. */
function hostLink(path) {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return readlinkSync(path);
    return st.isDirectory() ? null : undefined;
  } catch {
    return undefined;
  }
}

function which(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  for (const dir of ['/usr/bin', '/bin', '/usr/local/bin']) if (existsSync(join(dir, name))) return join(dir, name);
  return null;
}

/**
 * Can this host isolate? Linux on x86_64 with a working bubblewrap
 * (user namespaces allowed, the seccomp program accepted).
 * `{ available, reason, bwrap, version }`.
 */
export function detectSandbox({ platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'linux') return { available: false, reason: `the isolation boundary needs Linux with bubblewrap; this host is ${platform}` };
  if (arch !== 'x64') return { available: false, reason: `the seccomp filter is written for x86_64; this host is ${arch}` };
  const bwrap = which('bwrap');
  if (!bwrap) return { available: false, reason: 'bubblewrap (bwrap) is not installed' };
  const version = String(spawnSync(bwrap, ['--version'], { encoding: 'utf8' }).stdout ?? '').trim();
  const probe = runSync({ kind: 'bubblewrap', bwrap }, { argv: ['/usr/bin/true'], env: { PATH: '/usr/bin:/bin' }, cwd: '/' });
  if (probe.status !== 0) return { available: false, reason: `bubblewrap cannot create a sandbox here (user namespaces, seccomp): ${String(probe.stderr ?? '').trim().slice(0, 300)}`, bwrap, version };
  return { available: true, reason: null, bwrap, version };
}

let seccompFile = null;
function seccompPath() {
  if (seccompFile === null) {
    seccompFile = join(mkdtempSync(join(tmpdir(), 'bench-seccomp-')), 'filter.bpf');
    writeFileSync(seccompFile, seccompProgram());
  }
  return seccompFile;
}

/** The bubblewrap sandbox of a host where detectSandbox() found it available. */
export function bubblewrap(detected = detectSandbox()) {
  if (!detected.available) throw new Error(`no isolation boundary: ${detected.reason}`);
  return { kind: 'bubblewrap', enforced: true, bwrap: detected.bwrap, version: detected.version };
}

/** The isolation boundary, or an error saying why there is none (fail closed). */
export function requireSandbox() {
  return bubblewrap(detectSandbox());
}

/** For the harness's own tests on hosts without bubblewrap: commands run as they are, recorded as not enforced. */
export function unconfined(reason) {
  return { kind: 'none', enforced: false, reason };
}

/** A record of the isolation a verdict or run rested on. */
export function isolationRecord(isolation) {
  return isolation?.kind === 'bubblewrap'
    ? { kind: 'bubblewrap', enforced: true, version: isolation.version, seccomp_sha256: sha256Hex(seccompProgram()) }
    : { kind: 'none', enforced: false, reason: isolation?.reason ?? 'no isolation given' };
}

/**
 * The spawn plan of one command under `isolation`: `{ file, args, env,
 * cwd, fds }` where `fds` are extra descriptors to pass (3: the seccomp
 * program, 4: the info record when `infoPath` is given). Unconfined, the
 * command runs as it is.
 */
export function plan(isolation, { argv, env, cwd, binds = [], proxySocket = null, init = null, infoPath = null }) {
  if (isolation?.kind !== 'bubblewrap') return { file: argv[0], args: argv.slice(1), env, cwd, fds: [] };
  const fds = [openSync(seccompPath(), 'r')];
  if (infoPath) fds.push(openSync(infoPath, 'w'));
  const args = [...bwrapArgs({ binds, env, cwd, proxySocket, init, seccompFd: 3, infoFd: infoPath ? 4 : null }), ...argv];
  // bwrap itself gets only what it needs to start; the command's environment is set inside.
  return { file: isolation.bwrap, args, env: { PATH: '/usr/bin:/bin' }, cwd: '/', fds };
}

const closeAll = (fds) => {
  for (const fd of fds) {
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  }
};

/** spawnSync under `isolation` (options: encoding, input, timeout, killSignal, maxBuffer). */
export function runSync(isolation, spec, options = {}) {
  const p = plan(isolation, spec);
  try {
    return spawnSync(p.file, p.args, { ...options, cwd: p.cwd, env: p.env, stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', ...p.fds], windowsHide: true });
  } finally {
    closeAll(p.fds);
  }
}

/** spawn under `isolation`; `stdio` is the usual triple, the plan's descriptors are appended. */
export function start(isolation, spec, { stdio, detached }) {
  const p = plan(isolation, spec);
  try {
    return spawn(p.file, p.args, { cwd: p.cwd, env: p.env, stdio: [...stdio, ...p.fds], detached, windowsHide: true, shell: false });
  } finally {
    closeAll(p.fds);
  }
}

/** The PID namespace of a process, or null. */
export function pidNamespace(pid) {
  try {
    return readlinkSync(`/proc/${pid}/ns/pid`);
  } catch {
    return null;
  }
}

/** Processes still alive in PID namespace `ns` (e.g. 'pid:[4026532205]'). */
export function processesIn(ns) {
  if (!ns || process.platform !== 'linux') return [];
  const out = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    if (pidNamespace(name) === ns) {
      // Zombies and tasks already exiting are the namespace's teardown, not survivors.
      let state = '?';
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      } catch {
        continue;
      }
      if (state === 'Z' || state === 'X') continue;
      let cmd = '';
      try {
        cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 200);
      } catch {
        cmd = '?';
      }
      out.push({ pid: Number(name), cmd });
    }
  }
  return out;
}

/** The sandbox's PID 1 as bwrap's info record names it, and its namespace. */
export function sandboxInit(infoPath) {
  try {
    const pid = JSON.parse(readFileSync(infoPath, 'utf8'))['child-pid'];
    return Number.isInteger(pid) ? { pid, ns: pidNamespace(pid) } : null;
  } catch {
    return null;
  }
}
