/**
 * Agent-session isolation: the sandbox profile a session runs in, the
 * survivors it may leave, and the fail-closed preflight that proves the
 * profile before any session starts.
 *
 * A session runs inside the bubblewrap boundary (lib/sandbox.mjs) with
 * only its workspace and its fresh HOME writable; read-only it sees the
 * sealed Mycelink package (in the with arm only: without it the package
 * does not exist inside), its toolchain (Node, and the JDK when the
 * project needs one, on a PATH of its own) and the claude executable
 * (at CLAUDE_BIN_DIR, on that PATH, where Mycelink's workers find it).
 * Inside the writable HOME, the private copies of the sealed caches
 * installs copy from (the pnpm content store, corepack's pinned pnpm) are
 * read-only too (`sealedCacheBinds`).
 * With a JDK, its JVMs get `user.home` at the HOME (`javaUserHome`).
 * The evaluator store, the caches, the suite, the development checkout,
 * the operator's home and the Windows drives do not exist inside; the only
 * way out is the model proxy (lib/model-proxy.mjs), reached through the
 * in-sandbox launcher (lib/sandbox-init.mjs) as HTTPS_PROXY.
 *
 * `agentPreflight` runs lib/isolation-probe.mjs in exactly that profile
 * and checks, from inside, that every forbidden root is absent, the
 * read-only paths refuse writes, there is no direct network and no
 * resolver, the proxy allows its allowlist and refuses anything else,
 * AF_VSOCK and nested user namespaces are refused, there are no
 * capabilities, Windows interop is unreachable, a JVM's user.home is the
 * HOME (with a JDK) — and, from outside, that nothing the probe left
 * behind survived the sandbox. Any failure, or anything the probe cannot
 * establish, refuses the run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INIT_SCRIPT, PROXY_PORT, pidNamespace, processesIn, sandboxInit, start } from './sandbox.mjs';
import { COREPACK_HOME, PNPM_STORE } from './workspace.mjs';

/** The launcher every confined session starts through (bound read-only at INIT_SCRIPT). */
export const INIT_SOURCE = fileURLToPath(new URL('./sandbox-init.mjs', import.meta.url));
/** The preflight probe (bound read-only at PROBE_SCRIPT). */
export const PROBE_SOURCE = fileURLToPath(new URL('./isolation-probe.mjs', import.meta.url));
export const PROBE_SCRIPT = '/run/bench/probe.mjs';
/** Where the claude executable appears inside a session's sandbox: first on its PATH. */
export const CLAUDE_BIN_DIR = '/run/bench/bin';

/** What a confined session's environment adds: the proxy, and no nonessential traffic. */
export const PROXY_ENV = {
  HTTPS_PROXY: `http://127.0.0.1:${PROXY_PORT}`,
  https_proxy: `http://127.0.0.1:${PROXY_PORT}`,
  HTTP_PROXY: `http://127.0.0.1:${PROXY_PORT}`,
  http_proxy: `http://127.0.0.1:${PROXY_PORT}`,
  NO_PROXY: 'localhost,127.0.0.1,::1',
  no_proxy: 'localhost,127.0.0.1,::1',
};

/** An executable on `PATH`, resolved through symlinks; null when absent. */
export function resolveExecutable(name, PATH = process.env.PATH ?? '') {
  if (isAbsolute(name)) return existsSync(name) ? realpathSync(name) : null;
  for (const dir of PATH.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return null;
}

/**
 * The toolchain a session works with: the pinned Node (and JDK) bound
 * read-only, and a PATH of their directories and the system's only.
 */
export function agentToolchain({ adapter, toolchains }) {
  const nodeBin = toolchains?.node?.bin ?? dirname(process.execPath);
  const javaHome = adapter.toolchain?.runtime === 'java' ? toolchains?.java?.home ?? null : null;
  const dirs = [dirname(nodeBin), dirname(dirname(process.execPath)), ...(javaHome ? [javaHome] : [])];
  const binds = [...new Set(dirs)].filter((d) => !d.startsWith('/usr/')).map((path) => ({ path }));
  const path = [CLAUDE_BIN_DIR, nodeBin, ...(javaHome ? [join(javaHome, 'bin')] : []), '/usr/local/bin', '/usr/bin', '/bin'].join(':');
  return { binds, path, env: javaHome ? { JAVA_HOME: javaHome } : {}, java: javaHome !== null };
}

/**
 * The sealed caches a session HOME holds private copies of, bound read-only
 * over those copies: the pnpm content store (its SQLite index stays
 * writable — pnpm opens it read-write even offline) and corepack's pinned
 * pnpm. Every install in the session (a Mycelink worktree setup, the
 * agent's own) copies from them; nothing in the session can change what
 * they serve. Projects without a pnpm store get none.
 */
export function sealedCacheBinds({ adapter, home }) {
  if (adapter.toolchain?.cache?.kind !== 'pnpm-store') return [];
  const store = join(home, ...PNPM_STORE);
  const binds = [];
  for (const name of existsSync(store) ? readdirSync(store).sort() : []) {
    const files = join(store, name, 'files');
    if (existsSync(files)) binds.push({ path: files });
  }
  const corepack = join(home, ...COREPACK_HOME);
  if (existsSync(corepack)) binds.push({ path: corepack });
  return binds;
}

/**
 * The JVM option a session with a JDK runs with: `user.home` at its fresh
 * HOME. A JVM takes `user.home` from the passwd entry, not from $HOME, so
 * without it the Maven wrapper and Maven look for the distribution,
 * settings.xml and local repository in the operator's ~/.m2 — which the
 * sandbox does not have — instead of the private copies in the HOME. Set
 * as JAVA_TOOL_OPTIONS, every JVM of the session sees it: the wrapper,
 * Maven, Surefire's forks, and those of the workers the session starts
 * (they inherit its environment). A HOME the option would split or quote
 * is refused.
 */
export function javaUserHome(home) {
  if (/[\s"']/.test(home)) throw new Error(`the session HOME ${home} cannot be passed as -Duser.home in JAVA_TOOL_OPTIONS (whitespace or quotes): put runs in a plain path`);
  return `-Duser.home=${home}`;
}

/** Is `path` at or inside `root`? */
const under = (path, root) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * The sandbox of one agent session: `{ argv, binds, env }` for
 * lib/sandbox.mjs. `claude` is the command as given (`['claude']`, or an
 * interpreter and a script); a single executable is bound at
 * CLAUDE_BIN_DIR/claude, any other absolute path in it read-only where it is.
 *
 * The sealed plugin at `artifactDir` is bound read-only when `loadPlugin`
 * (the with arm), and `--plugin-dir` may name it and nothing else. Without
 * it the package does not exist inside at all: no bind at, inside or above
 * it, no argument naming it — anything else throws. Both arms' profiles are
 * otherwise the same.
 */
export function sessionSandbox({ workspace, home, artifactDir, loadPlugin, claude, args, toolchain, env, extraBinds = [] }) {
  if (typeof loadPlugin !== 'boolean') throw new Error('sessionSandbox needs loadPlugin: whether the session loads the sealed plugin');
  if (loadPlugin) {
    const loaded = args.flatMap((a, i) => (a === '--plugin-dir' ? [args[i + 1]] : a.startsWith('--plugin-dir=') ? [a.slice('--plugin-dir='.length)] : []));
    const other = loaded.filter((d) => d !== artifactDir);
    if (other.length) throw new Error(`a with-arm session loads only the sealed plugin ${artifactDir}, not ${other.join(', ')}`);
  }
  const binds = [{ path: workspace, rw: true }, { path: home, rw: true }, ...(loadPlugin ? [{ path: artifactDir }] : []), ...toolchain.binds];
  let argv;
  if (claude.length === 1) {
    const exe = resolveExecutable(claude[0]);
    if (!exe) throw new Error(`the claude executable ${claude[0]} was not found`);
    binds.push({ path: exe, dest: `${CLAUDE_BIN_DIR}/claude` });
    argv = [`${CLAUDE_BIN_DIR}/claude`, ...args];
  } else {
    // An interpreter and a script (the tests' stand-in): each absolute path at a neutral place, so that
    // no directory around it (a checkout, say) appears inside the sandbox.
    argv = claude.map((part, i) => {
      if (!isAbsolute(part) || !existsSync(part)) return part;
      const dest = `/run/bench/cmd/${i}/${basename(part)}`;
      binds.push({ path: part, dest });
      return dest;
    });
    argv.push(...args);
  }
  binds.push(...extraBinds);
  if (!loadPlugin) {
    const exposing = binds.flatMap((b) => [b.path, b.dest ?? b.path]).filter((p) => under(p, artifactDir) || under(artifactDir, p));
    const naming = argv.filter((a) => a === '--plugin-dir' || a.startsWith('--plugin-dir=') || a.includes(artifactDir));
    if (exposing.length || naming.length) throw new Error(`a session without the plugin may not see it: ${[...exposing.map((p) => `bind ${p}`), ...naming.map((a) => `argument ${a}`)].join('; ')}`);
  }
  const jvmOptions = toolchain.java ? javaUserHome(home) : null;
  return {
    argv: [process.execPath, INIT_SCRIPT, '--', ...argv],
    binds,
    env: { ...env, PATH: toolchain.path, ...toolchain.env, ...(jvmOptions ? { JAVA_TOOL_OPTIONS: jvmOptions } : {}), ...PROXY_ENV },
    cwd: workspace,
    init: INIT_SOURCE,
    jvmOptions,
  };
}

/** Live members of process group `pgid` (Linux), zombies aside. */
export function processGroupMembers(pgid) {
  if (process.platform !== 'linux' || !pgid) return [];
  const out = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const [state, , pgrp] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(pgrp) === pgid && state !== 'Z') out.push({ pid: Number(name), cmd: readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 200) });
    } catch {
      // gone meanwhile
    }
  }
  return out;
}

/**
 * Processes a session left behind — in its PID namespace when confined,
 * in its process group otherwise (Linux) — killed, and named.
 */
export function reapSurvivors({ ns = null, pgid = null, graceMs = 1000 }) {
  const scan = () => (ns ? processesIn(ns) : processGroupMembers(pgid));
  // A PID namespace is torn down when its PID 1 exits; give the kernel a moment before calling anything a survivor.
  let found = scan();
  const deadline = Date.now() + graceMs;
  while (found.length > 0 && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    found = scan();
  }
  for (const p of found) {
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  return found;
}

/**
 * Follow a starting sandbox's info record: `stop()` returns its PID
 * namespace (read while the sandbox's PID 1 lived), or null.
 */
export function trackNamespace(infoPath, intervalMs = 25) {
  let ns = null;
  const poll = () => {
    if (ns === null) ns = sandboxInit(infoPath)?.ns ?? null;
  };
  const timer = setInterval(poll, intervalMs);
  return {
    get ns() {
      poll();
      return ns;
    },
    stop() {
      clearInterval(timer);
      return ns;
    },
  };
}

/**
 * The directories the sandbox shows as skeletons (ancestors of bound
 * paths) that must hold nothing but those paths' components: the
 * operator's home, at least.
 */
export function skeletonListings({ binds, roots = [homedir()] }) {
  const listings = [];
  for (const root of roots) {
    const names = [...new Set(binds.map((b) => b.dest ?? b.path).filter((p) => under(p, root) && p !== root).map((p) => relative(root, p).split(sep)[0]))].sort();
    listings.push({ path: root, allowed: names });
  }
  return listings;
}

/**
 * Run the probe in `profile` (a sessionSandbox result whose argv is
 * replaced by the probe) and check the boundary from inside and outside.
 * Returns `{ ok, checks }`; never throws for a failed check.
 */
export async function agentPreflight({ isolation, profile, proxySocket, forbidden, readonly = [], writable = [], proxy, lingerSeconds = 4321 }) {
  const checks = [];
  const check = (id, ok, detail) => checks.push({ id, ok: Boolean(ok), detail });
  if (isolation?.kind !== 'bubblewrap') {
    check('boundary', false, 'no isolation boundary: agent sessions would run as the operator');
    return { ok: false, checks };
  }
  const infoDir = mkdtempSync(join(tmpdir(), 'bench-preflight-'));
  const infoPath = join(infoDir, 'info.json');
  const linger = `${lingerSeconds}.${process.pid % 1000}`;
  const spec = {
    forbidden,
    listing: skeletonListings({ binds: profile.binds }),
    readonly,
    writable,
    external: { host: '1.1.1.1', port: 443 },
    dns: 'api.anthropic.com',
    proxy: { port: PROXY_PORT, ...proxy },
    lingerSeconds: linger,
    // A profile with a JDK: a JVM started as the session would start one must see user.home at its HOME.
    ...(profile.jvmOptions ? { java: { home: profile.env.HOME } } : {}),
  };
  try {
    const spawned = start(
      isolation,
      {
        argv: [process.execPath, INIT_SCRIPT, '--', process.execPath, PROBE_SCRIPT],
        env: profile.env,
        cwd: profile.cwd,
        binds: [...profile.binds, { path: PROBE_SOURCE, dest: PROBE_SCRIPT }],
        proxySocket,
        init: profile.init,
        infoPath,
      },
      { stdio: ['pipe', 'pipe', 'pipe'], detached: true },
    );
    const tracker = trackNamespace(infoPath);
    let stdout = '';
    let stderr = '';
    spawned.stdout.on('data', (d) => {
      stdout += d;
    });
    spawned.stderr.on('data', (d) => {
      stderr += d;
    });
    spawned.stdin.on('error', () => {});
    spawned.stdin.end(JSON.stringify(spec));
    const timer = setTimeout(() => spawned.kill('SIGKILL'), 120_000);
    const status = await new Promise((done) => {
      spawned.on('error', (error) => {
        stderr += error.message;
        done(null);
      });
      spawned.on('close', (code) => done(code));
    });
    clearTimeout(timer);
    const ns = tracker.stop();
    let probe = null;
    try {
      probe = JSON.parse(stdout.trim().split('\n').at(-1));
    } catch {
      probe = null;
    }
    check('probe', status === 0 && probe !== null, status === 0 && probe ? 'the probe ran inside the sandbox' : `the probe failed (exit ${status}): ${stderr.trim().slice(0, 300)}`);
    for (const c of probe?.checks ?? []) checks.push(c);
    // From outside: nothing the probe started outlived the sandbox (anything that did is killed).
    const left = reapSurvivors({ ns });
    const stray = spawnSync('pgrep', ['-f', `^/usr/bin/sleep ${linger.replace('.', '\\.')}$`], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).map(Number);
    for (const pid of stray) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    check('survivors', ns !== null && left.length === 0 && stray.length === 0, ns === null ? 'the sandbox reported no PID namespace' : left.length || stray.length ? `still running after the sandbox: ${[...left.map((p) => p.cmd), ...stray.map((p) => `pid ${p}`)].join('; ')}` : 'nothing the probe started outlived the sandbox');
  } finally {
    rmSync(infoDir, { recursive: true, force: true });
  }
  return { ok: checks.length > 0 && checks.every((c) => c.ok), checks };
}

export { pidNamespace };
