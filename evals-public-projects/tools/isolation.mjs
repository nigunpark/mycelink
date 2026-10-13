#!/usr/bin/env node
/**
 * Check, before any pilot, that this host can confine agent sessions: the
 * same preflight run-arm performs before every run, in a throwaway session
 * profile, against this host's real suite, cache, evaluator store and
 * development checkout.
 *
 *   node evals-public-projects/tools/isolation.mjs check [--cache-root <dir>] [--authoring-root <dir>]...
 *        [--allow-host <host:port>]... [--out <file.json>]
 *
 * Exit codes: 0 the boundary holds (every check passed, including a
 * CONNECT to the model API through the proxy), 1 a check failed, 2 there is
 * no bubblewrap boundary on this host (see README.md, Isolation).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { forbiddenRunRoots } from '../lib/arms.mjs';
import { parseArgs, runTool } from '../lib/cli.mjs';
import { agentPreflight, agentToolchain, sessionSandbox } from '../lib/isolation.mjs';
import { suiteRoot } from '../lib/manifests.mjs';
import { DEFAULT_ALLOW, startModelProxy } from '../lib/model-proxy.mjs';
import { requireSandbox } from '../lib/sandbox.mjs';
import { loadToolchains, resolveCacheRoot } from '../lib/toolchain.mjs';

export async function main(argv) {
  let positionals;
  let flags;
  try {
    ({ positionals, flags } = parseArgs(argv, { valued: ['cache-root', 'out'], repeated: ['authoring-root', 'allow-host'] }));
  } catch (error) {
    return { ok: false, exit: 2, errors: [`usage: ${error.message}`] };
  }
  if (positionals[0] !== 'check') return { ok: false, exit: 2, errors: ['usage: isolation.mjs check [--cache-root <dir>] [--authoring-root <dir>]... [--allow-host <host:port>]...'] };
  let isolation;
  try {
    isolation = requireSandbox();
  } catch (error) {
    return { ok: false, exit: 2, errors: [`${error.message}: install bubblewrap and allow unprivileged user namespaces (see evals-public-projects/README.md, Isolation)`] };
  }
  const cacheRoot = resolveCacheRoot({ explicit: flags['cache-root'] });
  let toolchains = null;
  try {
    toolchains = loadToolchains(cacheRoot);
  } catch {
    toolchains = null;
  }
  const scratch = mkdtempSync(join(tmpdir(), 'bench-isolation-'));
  const allow = [...DEFAULT_ALLOW, ...(flags['allow-host'] ?? [])];
  try {
    const [workspace, home, plugin] = ['workspace', 'home', 'plugin'].map((d) => join(scratch, d));
    for (const d of [workspace, home, plugin]) mkdirSync(d);
    writeFileSync(join(scratch, 'proxy.jsonl'), '');
    const profiles = [];
    for (const runtime of ['node', 'java']) {
      if (runtime === 'java' && !toolchains?.java?.home) continue;
      const toolchain = agentToolchain({ adapter: { toolchain: { runtime } }, toolchains });
      profiles.push({ runtime, p: sessionSandbox({ workspace, home, artifactDir: plugin, loadPlugin: true, claude: ['claude'], args: ['--version'], toolchain, env: { HOME: home, LANG: 'C.UTF-8', TMPDIR: home } }) });
    }
    const proxy = await startModelProxy({ socket: join(scratch, 'proxy.sock'), log: join(scratch, 'proxy.jsonl'), allow });
    const forbidden = [...new Set([...forbiddenRunRoots({ suiteRoot: suiteRoot(), cacheRoot, authoring: (flags['authoring-root'] ?? []).map((p) => resolve(p)) }), join(suiteRoot(), '.local'), '/mnt/c', '/mnt/wsl'])];
    const results = [];
    try {
      for (const { runtime, p } of profiles) {
        // With a JDK, also the operator's ~/.m2 (the session's JVMs read the HOME's copy: their user.home is the HOME).
        const r = await agentPreflight({ isolation, profile: p, proxySocket: proxy.socket, forbidden: [...forbidden, ...(p.jvmOptions ? [join(homedir(), '.m2')] : [])], readonly: [plugin], writable: [workspace, home], proxy: { allowed: allow[0], denied: 'example.com:443' } });
        results.push({ runtime, ok: r.ok, failed: r.checks.filter((c) => !c.ok), checks: r.checks.length });
      }
    } finally {
      await proxy.stop();
    }
    const out = { ok: results.length > 0 && results.every((r) => r.ok), command: 'check', bubblewrap: isolation.version, cache_root: cacheRoot, forbidden, allow, results };
    if (flags.out) out.out = flags.out;
    return out;
  } catch (error) {
    return { ok: false, exit: 2, errors: [String(error?.message ?? error)] };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

runTool(import.meta.url, main);
