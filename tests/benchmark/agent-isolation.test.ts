/**
 * Agent sessions run inside the isolation boundary, model-free: a scripted
 * stand-in for `claude -p` (fake-claude.mjs) probes what a session can
 * reach.
 *
 * - The model proxy (its own process, on a Unix socket) allows exactly its
 *   allowlist and answers anything else with 403, logging every connection.
 * - The preflight runs a probe in the exact session profile: forbidden
 *   roots absent, read-only paths read-only, no direct network or resolver,
 *   the proxy's allowlist only, no AF_VSOCK, no capabilities, no Windows
 *   interop, nothing outliving the sandbox; a profile that exposes a
 *   forbidden root fails it, and the run refuses to start any session.
 * - A confined session sees its workspace, HOME, the sealed plugin (with
 *   arm only: a without-arm session cannot stat, read, find or run it) and
 *   its toolchain only, reaches the model only through the proxy, and leaves
 *   nothing behind; the run records the boundary, the preflight, the
 *   proxy's connections and the survivors (none).
 *
 * The sandbox itself needs Linux with bubblewrap (WSL here); elsewhere the
 * run records that its sessions were not confined, and is never trusted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { cleanupTmpRoots, makeTmpDir } from '../helpers/tmp.js';
import { ISOLATED, TEST_ISOLATION } from './isolation-fixture.js';
import { REPO_ROOT } from '../helpers/global-setup.js';
import { TOY, TOY_PRD, preparedToy, type Toy } from './toy-fixture.js';
// @ts-expect-error -- plain ESM module without type declarations
import { allowed, connectTarget, proxySummary, startModelProxy } from '../../evals-public-projects/lib/model-proxy.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { agentPreflight, agentToolchain, processGroupMembers, reapSurvivors, resolveExecutable, sessionSandbox } from '../../evals-public-projects/lib/isolation.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { INIT_SCRIPT, runSync } from '../../evals-public-projects/lib/sandbox.mjs';
// @ts-expect-error -- plain ESM module without type declarations
import { claudeArgs, runArm, runVerdict } from '../../evals-public-projects/lib/arms.mjs';

afterAll(() => cleanupTmpRoots());

const FAKE = join(REPO_ROOT, 'tests', 'benchmark', 'fake-claude.mjs');
/** A JDK on this host (its `java` resolved through symlinks), for the JVM checks; null when there is none. */
const JAVA = resolveExecutable('java');
const JDK: string | null = JAVA ? dirname(dirname(JAVA)) : null;
const AGENT_TESTS = Object.fromEntries(Object.entries(TOY.referenceTests).map(([p, body]) => [p, `// written by the agent\n${body}`]));
const socketPath = (dir: string) => (process.platform === 'win32' ? `\\\\.\\pipe\\bench-proxy-${process.pid}-${Math.random().toString(16).slice(2)}` : join(dir, 'proxy.sock'));

/** Every file under `dir` (none when it does not exist). */
function walk(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []));
}

/** A TCP server on the host that answers every connection with "echo". */
function echoServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((done) => {
    const server = net.createServer((c) => c.end('echo')).listen(0, '127.0.0.1', () => done({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }));
  });
}

/** Send `request` to the proxy socket; resolve with the first line and the rest of the answer. */
function ask(socket: string, request: string): Promise<{ line: string; rest: string }> {
  return new Promise((done) => {
    const s = net.connect(socket);
    let got = '';
    s.on('connect', () => s.write(request));
    s.on('data', (d) => {
      got += d;
    });
    s.on('close', () => done({ line: got.split('\r\n')[0], rest: got.split('\r\n\r\n').slice(1).join('\r\n\r\n') }));
    s.on('error', () => done({ line: 'error', rest: '' }));
  });
}

describe('the model proxy', () => {
  it('parses exactly one CONNECT target, and allows only exact allowlist entries', () => {
    expect(connectTarget('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: x')).toEqual({ host: 'api.anthropic.com', port: 443 });
    expect(connectTarget('GET http://api.anthropic.com/ HTTP/1.1')).toBeNull();
    expect(connectTarget('CONNECT api.anthropic.com:443 HTTP/1.1 extra')).toBeNull();
    expect(connectTarget('CONNECT a b:443 HTTP/1.1')).toBeNull();
    expect(allowed({ host: 'api.anthropic.com', port: 443 }, ['api.anthropic.com:443'])).toBe(true);
    expect(allowed({ host: 'api.anthropic.com', port: 80 }, ['api.anthropic.com:443'])).toBe(false);
    expect(allowed({ host: 'evil.api.anthropic.com', port: 443 }, ['api.anthropic.com:443'])).toBe(false);
    expect(allowed(null, ['api.anthropic.com:443'])).toBe(false);
  });

  it('tunnels to an allowlisted target, answers anything else with 403, and logs every connection', async () => {
    const echo = await echoServer();
    const dir = makeTmpDir('bench-proxy-');
    const log = join(dir, 'proxy.jsonl');
    writeFileSync(log, '');
    const proxy = await startModelProxy({ socket: socketPath(dir), log, allow: [`127.0.0.1:${echo.port}`] });
    try {
      const ok = await ask(proxy.socket, `CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: x\r\n\r\n`);
      expect(ok.line).toBe('HTTP/1.1 200 Connection Established');
      expect(ok.rest).toBe('echo');
      expect((await ask(proxy.socket, 'CONNECT example.invalid:443 HTTP/1.1\r\n\r\n')).line).toBe('HTTP/1.1 403 Forbidden');
      expect((await ask(proxy.socket, `CONNECT 127.0.0.1:${echo.port + 1} HTTP/1.1\r\n\r\n`)).line).toBe('HTTP/1.1 403 Forbidden');
      expect((await ask(proxy.socket, 'GET http://example.invalid/ HTTP/1.1\r\n\r\n')).line).toBe('HTTP/1.1 403 Forbidden');
    } finally {
      await proxy.stop();
      echo.close();
    }
    const summary = proxySummary(readFileSync(log, 'utf8').split('\n'));
    expect(summary).toEqual({
      connections: 4,
      allowed: { [`127.0.0.1:${echo.port}`]: 1 },
      denied: { 'example.invalid:443': 1, [`127.0.0.1:${echo.port + 1}`]: 1, 'GET http://example.invalid/ HTTP/1.1': 1 },
    });
  }, 60_000);
});

describe('survivors', () => {
  it.runIf(process.platform === 'linux')('finds and kills what a session left in its process group', async () => {
    const leader = spawn('/bin/sh', ['-c', '/usr/bin/sleep 61.25 & exit 0'], { detached: true, stdio: 'ignore' });
    await new Promise((r) => leader.on('exit', r));
    // Under load the forked child may not have exec'd sleep yet: wait until it has.
    let before: any[] = [];
    for (let i = 0; i < 100 && !before.some((p: any) => p.cmd.startsWith('/usr/bin/sleep')); i++) {
      await new Promise((r) => setTimeout(r, 20));
      before = processGroupMembers(leader.pid);
    }
    expect(before.map((p: any) => p.cmd)).toEqual(['/usr/bin/sleep 61.25']);
    expect(reapSurvivors({ pgid: leader.pid }).length).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(processGroupMembers(leader.pid)).toEqual([]);
  });
});

describe('the agent sandbox', () => {
  let toy: Toy;
  beforeAll(async () => {
    ({ toy } = await preparedToy());
  }, 300_000);

  /** A run directory like runArm's: a workspace, a HOME and the sealed "plugin" beside them. */
  function runDirs() {
    const root = makeTmpDir('bench-iso-');
    const workspace = join(root, 'workspace');
    const home = join(root, 'home');
    const plugin = join(root, 'plugin');
    for (const d of [workspace, home, plugin]) mkdirSync(d);
    mkdirSync(join(plugin, '.claude-plugin'));
    writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), '{}');
    return { workspace, home, plugin, root };
  }
  /** A session profile like runArm's, of the with arm (the plugin loaded) or the without arm. */
  function profile(extraBinds: any[] = [], loadPlugin = true, dirs = runDirs()) {
    const { workspace, home, plugin } = dirs;
    const toolchain = agentToolchain({ adapter: { toolchain: { runtime: 'node' } }, toolchains: null });
    const args = claudeArgs({ plugin: loadPlugin, pluginDir: plugin });
    const p = sessionSandbox({ workspace, home, artifactDir: plugin, loadPlugin, claude: [process.execPath, FAKE], args, toolchain, env: { HOME: home, LANG: 'C.UTF-8' }, extraBinds });
    return { p, ...dirs };
  }
  /** Is `path` the plugin directory, inside it, or one of its ancestors? */
  const around = (path: string, plugin: string) => {
    const r = relative(plugin, path);
    const s = relative(path, plugin);
    return r === '' || !(r.startsWith('..') || isAbsolute(r)) || !(s.startsWith('..') || isAbsolute(s));
  };

  it('puts a session on a PATH of its own toolchain, behind the proxy, with claude where Mycelink workers find it', () => {
    const { p, workspace, home, plugin } = profile();
    expect(p.argv.slice(0, 3)).toEqual([process.execPath, '/run/bench/init.mjs', '--']);
    expect(p.binds).toEqual(expect.arrayContaining([{ path: workspace, rw: true }, { path: home, rw: true }, { path: plugin }, { path: FAKE, dest: '/run/bench/cmd/1/fake-claude.mjs' }]));
    expect(p.argv.slice(3, 5)).toEqual([`/run/bench/cmd/0/${basename(process.execPath)}`, '/run/bench/cmd/1/fake-claude.mjs']);
    expect(p.binds.filter((b: any) => b.rw).map((b: any) => b.path).sort()).toEqual([home, workspace].sort());
    expect(p.env.PATH.split(':')[0]).toBe('/run/bench/bin');
    expect(p.env).toMatchObject({ HTTPS_PROXY: 'http://127.0.0.1:3128', NO_PROXY: 'localhost,127.0.0.1,::1' });
  });

  it('gives a session with a JDK a JVM whose user.home is its fresh HOME, and records the option', () => {
    const { workspace, home, plugin } = runDirs();
    const make = (runtime: string, at = home) =>
      sessionSandbox({
        workspace,
        home: at,
        artifactDir: plugin,
        loadPlugin: false,
        claude: [process.execPath, FAKE],
        args: claudeArgs({ plugin: false }),
        toolchain: agentToolchain({ adapter: { toolchain: { runtime } }, toolchains: { java: { home: '/opt/jdk-21' }, node: { bin: dirname(process.execPath) } } }),
        env: { HOME: at },
      });
    const java = make('java');
    // The JVM takes user.home from the passwd entry, not from $HOME: Maven and its wrapper would look in the operator's ~/.m2.
    expect(java.env.JAVA_TOOL_OPTIONS).toBe(`-Duser.home=${home}`);
    expect(java.jvmOptions).toBe(`-Duser.home=${home}`);
    expect(java.env.JAVA_HOME).toBe('/opt/jdk-21');
    const node = make('node');
    expect(node.env.JAVA_TOOL_OPTIONS).toBeUndefined();
    expect(node.jvmOptions).toBeNull();
    // JAVA_TOOL_OPTIONS splits on whitespace: a HOME it would split is refused, never passed broken.
    expect(() => make('java', join(home, 'with space'))).toThrow(/user\.home/);
  });

  it.runIf(ISOLATED && JDK !== null)('runs a session JVM with user.home at its HOME, where the operator’s ~/.m2 does not exist', () => {
    const dirs = runDirs();
    const toolchain = agentToolchain({ adapter: { toolchain: { runtime: 'java' } }, toolchains: { java: { home: JDK }, node: { bin: dirname(process.execPath) } } });
    const p = sessionSandbox({ workspace: dirs.workspace, home: dirs.home, artifactDir: dirs.plugin, loadPlugin: false, claude: [process.execPath, FAKE], args: claudeArgs({ plugin: false }), toolchain, env: { HOME: dirs.home } });
    const script = `test -e ${homedir()}/.m2 && echo m2:visible || echo m2:absent; java -XshowSettings:properties -version 2>&1 | grep 'user.home ='`;
    const r = runSync(TEST_ISOLATION, { argv: [process.execPath, INIT_SCRIPT, '--', '/bin/bash', '-c', script], env: p.env, cwd: dirs.workspace, binds: p.binds, init: p.init }, { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('m2:absent');
    expect(r.stdout).toMatch(new RegExp(`user\\.home = ${dirs.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
  }, 120_000);

  it('gives a without-arm session no plugin: nothing bound at, around or inside the sealed package, and the with arm’s profile otherwise', () => {
    const dirs = runDirs();
    const without = profile([], false, dirs).p;
    const withPlugin = profile([], true, dirs).p;
    for (const b of without.binds) {
      expect(around(b.path, dirs.plugin), b.path).toBe(false);
      expect(around(b.dest ?? b.path, dirs.plugin), b.dest ?? b.path).toBe(false);
    }
    expect(without.argv.join(' ')).not.toContain('--plugin-dir');
    expect(without.argv.join(' ')).not.toContain(dirs.plugin);
    expect(JSON.stringify(without.env)).not.toContain(JSON.stringify(dirs.plugin).slice(1, -1));
    // The with arm: the sealed package, read-only, and only it; otherwise the very same profile.
    expect(withPlugin.binds.filter((b: any) => around(b.path, dirs.plugin))).toEqual([{ path: dirs.plugin }]);
    expect(withPlugin.binds.filter((b: any) => b.path !== dirs.plugin)).toEqual(without.binds);
    expect(withPlugin.argv).toEqual([...without.argv, '--plugin-dir', dirs.plugin]);
    expect(withPlugin.env).toEqual(without.env);
    expect(withPlugin.cwd).toBe(without.cwd);
  });

  it('refuses a profile that would show a without-arm session the plugin, or load another plugin in the with arm', () => {
    const { workspace, home, plugin, root } = runDirs();
    const toolchain = agentToolchain({ adapter: { toolchain: { runtime: 'node' } }, toolchains: null });
    const make = (o: Record<string, unknown>) => () =>
      sessionSandbox({ workspace, home, artifactDir: plugin, loadPlugin: false, claude: [process.execPath, FAKE], args: claudeArgs({ plugin: false }), toolchain, env: { HOME: home }, ...o });
    expect(make({ args: claudeArgs({ plugin: true, pluginDir: plugin }) })).toThrow(/without the plugin/);
    expect(make({ args: [...claudeArgs({ plugin: false }), `--add-dir=${plugin}`] })).toThrow(/without the plugin/);
    expect(make({ extraBinds: [{ path: root }] })).toThrow(/without the plugin/);
    expect(make({ extraBinds: [{ path: join(plugin, '.claude-plugin') }] })).toThrow(/without the plugin/);
    expect(make({ extraBinds: [{ path: join(root, 'elsewhere'), dest: plugin }] })).toThrow(/without the plugin/);
    expect(make({ loadPlugin: true, args: claudeArgs({ plugin: true, pluginDir: join(root, 'other') }) })).toThrow(/only the sealed plugin/);
    expect(make({ loadPlugin: undefined })).toThrow(/loadPlugin/);
    expect(make({})).not.toThrow();
  });

  it.runIf(ISOLATED)('proves the boundary from inside before any session: forbidden roots absent, network only through the proxy, nothing survives', async () => {
    const echo = await echoServer();
    const dir = makeTmpDir('bench-iso-proxy-');
    const log = join(dir, 'proxy.jsonl');
    writeFileSync(log, '');
    const proxy = await startModelProxy({ socket: socketPath(dir), log, allow: [`127.0.0.1:${echo.port}`] });
    try {
      const forbidden = [toy.suite, toy.cacheRoot, join(toy.cacheRoot, 'evaluator'), REPO_ROOT, toy.authoring];
      const run = ({ p: prof, workspace, home, plugin }: any) =>
        agentPreflight({ isolation: TEST_ISOLATION, profile: prof, proxySocket: proxy.socket, forbidden, readonly: [plugin], writable: [workspace, home], proxy: { allowed: `127.0.0.1:${echo.port}`, denied: 'example.invalid:443' } });
      const good = await run(profile());
      expect(good.checks.filter((c: any) => !c.ok)).toEqual([]);
      expect(good.ok).toBe(true);
      expect(good.checks.map((c: any) => c.id)).toEqual(
        expect.arrayContaining([`forbidden:${toy.cacheRoot}`, 'vsock', 'seccomp', 'capabilities', 'network:direct', 'network:dns', 'proxy:allowed', 'proxy:denied', 'interop:exec', 'survivors']),
      );
      // A profile that binds a forbidden root in (here: the cache with the evaluator store) fails the preflight.
      const leaky = await run(profile([{ path: toy.cacheRoot }]));
      expect(leaky.ok).toBe(false);
      expect(leaky.checks.filter((c: any) => !c.ok).map((c: any) => c.id)).toEqual(expect.arrayContaining([`forbidden:${toy.cacheRoot}`, `forbidden:${join(toy.cacheRoot, 'evaluator')}`]));
      // ... and so does one that makes the plugin writable.
      const writablePlugin = profile();
      writablePlugin.p.binds = writablePlugin.p.binds.map((b: any) => (b.path === writablePlugin.plugin ? { ...b, rw: true } : b));
      const w = await run(writablePlugin);
      expect(w.checks.filter((c: any) => !c.ok).map((c: any) => c.id)).toEqual([`readonly:${writablePlugin.plugin}`]);
    } finally {
      await proxy.stop();
      echo.close();
    }
  }, 120_000);

  it.runIf(ISOLATED && JDK !== null)('proves from inside that a session JVM’s user.home is the HOME and the operator’s ~/.m2 is absent', async () => {
    const echo = await echoServer();
    const dir = makeTmpDir('bench-iso-proxy-');
    const log = join(dir, 'proxy.jsonl');
    writeFileSync(log, '');
    const proxy = await startModelProxy({ socket: socketPath(dir), log, allow: [`127.0.0.1:${echo.port}`] });
    try {
      const dirs = runDirs();
      const toolchain = agentToolchain({ adapter: { toolchain: { runtime: 'java' } }, toolchains: { java: { home: JDK }, node: { bin: dirname(process.execPath) } } });
      const p = sessionSandbox({ workspace: dirs.workspace, home: dirs.home, artifactDir: dirs.plugin, loadPlugin: false, claude: [process.execPath, FAKE], args: claudeArgs({ plugin: false }), toolchain, env: { HOME: dirs.home } });
      const run = (prof: any) =>
        agentPreflight({ isolation: TEST_ISOLATION, profile: prof, proxySocket: proxy.socket, forbidden: [join(homedir(), '.m2')], writable: [dirs.workspace, dirs.home], proxy: { allowed: `127.0.0.1:${echo.port}`, denied: 'example.invalid:443' } });
      const good = await run(p);
      expect(good.checks.filter((c: any) => !c.ok)).toEqual([]);
      expect(good.checks.find((c: any) => c.id === 'java:user.home')).toMatchObject({ ok: true, detail: `user.home = ${dirs.home}` });
      expect(good.checks.find((c: any) => c.id === `forbidden:${join(homedir(), '.m2')}`)).toMatchObject({ ok: true });
      // Without the option the JVM falls back to the passwd home: the preflight refuses the profile.
      const bad = await run({ ...p, env: { ...p.env, JAVA_TOOL_OPTIONS: undefined } });
      expect(bad.checks.filter((c: any) => !c.ok).map((c: any) => c.id)).toEqual(['java:user.home']);
    } finally {
      await proxy.stop();
      echo.close();
    }
  }, 120_000);

  describe('a confined arm run', () => {
    const fakePlan = (extra: Record<string, unknown> = {}) => {
      const dir = makeTmpDir('bench-iso-fake-');
      const log = join(dir, 'log.jsonl');
      writeFileSync(log, '');
      const file = join(dir, 'plan.json');
      writeFileSync(file, JSON.stringify({ log, tests: AGENT_TESTS, code: TOY.referenceCode, regression: {}, ...extra }));
      return { dir, file, entries: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
    };
    const arm = (fake: { dir: string; file: string }, options: Record<string, unknown> = {}) =>
      runArm({
        suiteRoot: toy.suite,
        caseKey: TOY_PRD,
        arm: 'with',
        outDir: join(makeTmpDir('bench-iso-run-'), 'run'),
        cacheRoot: toy.cacheRoot,
        claude: [process.execPath, FAKE],
        pollMs: 100,
        env: { FAKE_CLAUDE_PLAN: fake.file },
        isolation: TEST_ISOLATION,
        sessionBinds: [{ path: fake.dir, rw: true }],
        // fake-claude is no Mycelink host: it changes product code itself. These runs are about the boundary, not the controller.
        controllerGuard: false,
        ...options,
      });

    it.runIf(ISOLATED)('runs the session inside the boundary: it reaches only the proxy, finds no store, suite or checkout, and leaves nothing behind', async () => {
      const echo = await echoServer();
      const linger = `${Math.floor(Math.random() * 1000) + 3000}.5`;
      const fake = fakePlan({
        probePaths: [toy.suite, toy.cacheRoot, join(toy.cacheRoot, 'evaluator', 'toyshop', TOY_PRD), REPO_ROOT, '/mnt/c'],
        connect: [`127.0.0.1:${echo.port}`, 'example.invalid:443'],
        linger,
      });
      let run: any;
      try {
        run = await arm(fake, { proxyAllow: [`127.0.0.1:${echo.port}`], preflightProxy: { allowed: `127.0.0.1:${echo.port}`, denied: 'example.invalid:443' } });
      } finally {
        echo.close();
      }
      const [session] = fake.entries();
      expect(Object.values(session.probed)).toEqual(['ENOENT', 'ENOENT', 'ENOENT', 'ENOENT', 'ENOENT']);
      expect(session.connected).toEqual({ [`127.0.0.1:${echo.port}`]: 'HTTP/1.1 200 Connection Established', 'example.invalid:443': 'HTTP/1.1 403 Forbidden' });
      expect(session.path.split(':')[0]).toBe('/run/bench/bin');
      expect(run.isolation).toMatchObject({ kind: 'bubblewrap', enforced: true, preflight: { ok: true } });
      expect(run.sessions.map((s: any) => [s.purpose, s.confined, s.survivors])).toEqual([['task', true, []]]);
      expect(run.network).toMatchObject({ allowed: { [`127.0.0.1:${echo.port}`]: expect.any(Number) }, denied: { 'example.invalid:443': 1 } });
      // The detached sleeper died with the sandbox's PID namespace.
      expect(spawnSync('pgrep', ['-f', `sleep ${linger}`], { encoding: 'utf8' }).stdout.trim()).toBe('');
      expect(run.ok).toBe(true);
    }, 300_000);

    it.runIf(ISOLATED)('shows a without-arm session no plugin it could stat, read, find or run, and names none in its transcripts; the with arm sees exactly the sealed one', async () => {
      const seen: Record<string, any> = {};
      for (const name of ['without', 'with']) {
        const outDir = join(makeTmpDir('bench-iso-arm-'), 'run');
        const plugin = join(outDir, 'plugin');
        const fake = fakePlan({
          probePaths: [plugin, join(plugin, '.claude-plugin', 'plugin.json'), join(plugin, 'bin', 'mycelink.mjs')],
          readPaths: [join(plugin, '.claude-plugin', 'plugin.json'), join(plugin, 'package.json')],
          list: [outDir],
          findPlugins: ['/'],
          invokeNode: [[join(plugin, 'bin', 'mycelink.mjs'), 'version']],
        });
        const run = await arm(fake, { arm: name, outDir });
        const [session] = fake.entries();
        const transcripts = [...run.sessions.flatMap((s: any) => [s.transcript, s.transcript.replace(/\.jsonl$/, '.stderr.log')]), ...walk(join(run.home, '.claude'))];
        seen[name] = { run, session, plugin, outDir, text: transcripts.map((f) => readFileSync(f, 'utf8')).join('\n') };
      }
      const { run: w, session: ws, plugin: wp, outDir: wd, text: wt } = seen.without;
      expect(Object.values(ws.probed)).toEqual(['ENOENT', 'ENOENT', 'ENOENT']);
      expect(Object.values(ws.read)).toEqual(['ENOENT', 'ENOENT']);
      expect(ws.listed[wd]).toEqual(['home', 'workspace']);
      expect(ws.plugins).toEqual([]);
      expect(ws.invoked).toEqual([1]);
      expect(ws.argv).not.toContain('--plugin-dir');
      expect(wt).not.toContain(wp);
      expect(wt).not.toContain('--plugin-dir');
      // The preflight proved it absent from inside, and the record names no exposure.
      expect(w.isolation.preflight.checks.find((c: any) => c.id === `forbidden:${wp}`)).toMatchObject({ ok: true });
      expect(w.isolation.profile.binds.filter((b: any) => around(b.path, wp) || around(b.dest, wp))).toEqual([]);
      expect(w.plugin_exposure).toEqual([]);
      expect(w.ok).toBe(true);
      // The positive control: the same probes find the sealed package in the with arm, and only it.
      const { run: t, session: ts, plugin: tp, outDir: td } = seen.with;
      expect(Object.values(ts.probed)).toEqual(['visible', 'visible', 'visible']);
      expect(Object.values(ts.read)).toEqual(['read', 'read']);
      expect(ts.listed[td]).toEqual(['home', 'plugin', 'workspace']);
      expect(ts.plugins).toEqual([join(tp, '.claude-plugin')]);
      expect(ts.invoked).toEqual([0]);
      expect(ts.argv.filter((a: string) => a === '--plugin-dir')).toHaveLength(1);
      expect(ts.argv.at(-1)).toBe(tp);
      expect(t.isolation.preflight.checks.find((c: any) => c.id === `readonly:${tp}`)).toMatchObject({ ok: true });
      expect(t.plugin_exposure).toEqual([]);
      expect(t.ok).toBe(true);
    }, 600_000);

    it.runIf(ISOLATED)('refuses to start any session when the preflight finds the boundary open', async () => {
      const fake = fakePlan();
      const run = await arm(fake, { sessionBinds: [{ path: fake.dir, rw: true }, { path: toy.cacheRoot }] });
      expect(run.sessions).toEqual([]);
      expect(run.isolation.preflight.ok).toBe(false);
      expect(run.isolation.preflight.checks.filter((c: any) => !c.ok).map((c: any) => c.id)).toContain(`forbidden:${toy.cacheRoot}`);
      expect(run.ok).toBe(false);
      expect(run.trusted).toBe(false);
      expect(run.verdict).toBe('untrusted');
      expect(run.trust.problems.join(' | ')).toMatch(/preflight failed: .*forbidden:/);
      expect(fake.entries()).toEqual([]);
    }, 300_000);

    it.runIf(ISOLATED)('keeps a delivery the model got wrong apart from the evidence: a trusted run whose delivery failed', async () => {
      const echo = await echoServer();
      let run: any;
      try {
        run = await arm(fakePlan({ code: { ...TOY.referenceCode, ...TOY.mutants['no-reject'] } }), { arm: 'without', proxyAllow: [`127.0.0.1:${echo.port}`], preflightProxy: { allowed: `127.0.0.1:${echo.port}`, denied: 'example.invalid:443' } });
      } finally {
        echo.close();
      }
      expect(run.ok).toBe(false);
      expect(run.delivery.ok).toBe(false);
      expect(run.delivery.failures.join(' | ')).toMatch(/acceptance:hidden:AC-2 an order larger than the stock is rejected/);
      // The session's evidence holds: confined, proved, nothing reached. What keeps the toy run from being trusted is
      // only the toy verdict's own trust record (an unpinned suite, a toy qualification on one file system) — never the delivery.
      expect(run.trust.problems.filter((p: string) => !/^the verification is not trusted: /.test(p))).toEqual([]);
      expect(run.trust.problems.join(' | ')).not.toMatch(/acceptance|hidden/);
      const confinedOnly = runVerdict({ record: run, verification: { ...JSON.parse(readFileSync(run.verification, 'utf8')), trusted: true } });
      expect(confinedOnly).toMatchObject({ verdict: 'delivery-failed', trust: { ok: true, problems: [] } });
    }, 300_000);

    it.runIf(!ISOLATED)('records, where there is no boundary, that its sessions were not confined, and is never trusted', async () => {
      const fake = fakePlan();
      const run = await arm(fake);
      expect(run.isolation).toMatchObject({ kind: 'none', enforced: false, preflight: null });
      expect(run.sessions.map((s: any) => s.confined)).toEqual([false]);
      expect(run.trusted).toBe(false);
    }, 300_000);
  });
});
