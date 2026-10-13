/**
 * A fresh host session recovers controller authority once the session that
 * held it is gone, and only then.
 *
 * Second PCM-101 pilot, with-faults arm: the host session was killed while
 * a settle was running. The resumed `claude -p` session had no controller
 * key (it is never stored), `--takeover` needs an interactive terminal, and
 * nobody was there to run it: the session asked a user who did not exist and
 * exited 0 with the feature incomplete.
 *
 * `controller open` now records which Claude Code session opened the key
 * (CLAUDE_PID, verified as an ancestor of the call, with its start).
 * `controller open --recover` mints a new key, revoking the old one, only
 * when that session is provably gone (its in-process subagents went with
 * it), the caller runs in a verifiable session of its own, and no adapter
 * worker or settle of the old session is still alive.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { FEATURE_ID, commitControl, createPortfolio, writePrd, type Portfolio } from '../helpers/portfolio-fixture.js';
import { FakeHost } from '../helpers/fake-host.js';
import { hostGraph } from '../helpers/host-loop.js';
import { authorityFile, openControllerAuthority } from '../../src/engine/authority.js';
import { recordSpawn } from '../../src/sessions/registry.js';
import { featurePaths } from '../../src/workspace/paths.js';

afterAll(() => cleanupTmpRoots());

const hosts: FakeHost[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.kill();
});

async function host(): Promise<FakeHost> {
  const h = await FakeHost.start();
  hosts.push(h);
  return h;
}

function portfolio(): Portfolio {
  const p = createPortfolio();
  writePrd(p);
  writeFileSync(join(p.featureDir, 'PORTFOLIO-GRAPH.yaml'), YAML.stringify(hostGraph(), { lineWidth: 0 }));
  commitControl(p, 'feature');
  return p;
}

const record = (p: Portfolio) => JSON.parse(readFileSync(authorityFile(p.control), 'utf8')) as { sha256: string; holder: { pid: number } | null; recovered?: boolean };

async function open(h: FakeHost, p: Portfolio, extra: string[] = []): Promise<{ code: number | null; err: string; key?: string; json?: Record<string, unknown> }> {
  const r = await h.run(['controller', 'open', '--control-root', p.control, '--json', ...extra]);
  if (r.code !== 0) return { code: r.code, err: r.err };
  const json = JSON.parse(r.out) as Record<string, unknown>;
  return { code: r.code, err: r.err, key: json['authority'] as string, json };
}

/** The CLI run from the test process itself: under no host session (or a forged one). */
function outside(p: Portfolio, argv: string[], env: Record<string, string> = {}): { code: number | null; err: string } {
  const base = { ...process.env, ...env };
  if (env['CLAUDE_PID'] === undefined) delete base['CLAUDE_PID'];
  const r = spawnSync(process.execPath, [p.mycelink, ...argv, '--control-root', p.control], { env: base, encoding: 'utf8', windowsHide: true });
  return { code: r.status, err: r.stderr };
}

describe('controller recovery', () => {
  it('records the session that opened the key; its own calls, and calls outside any session, cannot recover', async () => {
    const p = portfolio();
    const a = await host();
    const opened = await open(a, p);
    expect(opened.code).toBe(0);
    expect(record(p).holder).toMatchObject({ pid: a.pid });
    const sha = record(p).sha256;

    // A subagent of the live host runs as the same session: refused.
    const worker = await open(a, p, ['--recover']);
    expect(worker.code).not.toBe(0);
    expect(worker.err).toMatch(/CONTROLLER_BUSY: .*still running/);
    // No session, or a CLAUDE_PID that is not an ancestor of the call: refused.
    expect(outside(p, ['controller', 'open', '--recover']).err).toMatch(/CONTROLLER_BUSY: .*verifiable/);
    expect(outside(p, ['controller', 'open', '--recover'], { CLAUDE_PID: String(a.pid) }).err).toMatch(/CONTROLLER_BUSY: .*verifiable/);
    expect(record(p).sha256).toBe(sha);
  });

  it('a fresh session recovers once the holder is gone: the old key stops working, and the new holder is protected the same way', async () => {
    const p = portfolio();
    const a = await host();
    const first = (await open(a, p)).key!;
    expect((await a.run(['feature', 'init', FEATURE_ID, '--control-root', p.control, '--authority', first])).code).toBe(0);
    commitControl(p, 'init');
    // A host dispatch is in flight when the host dies: its worker died with it.
    expect(JSON.parse((await a.run(['dispatch', FEATURE_ID, '--control-root', p.control, '--authority', first, '--json'])).out).status).toBe('DISPATCHED');
    await a.kill();

    const b = await host();
    const recovered = await open(b, p, ['--recover']);
    expect(recovered.err).toBe('');
    expect(recovered.json).toMatchObject({ recovered: true, holder: { pid: b.pid } });
    expect(record(p)).toMatchObject({ recovered: true, holder: { pid: b.pid } });
    const stale = await b.run(['session', 'reconcile', FEATURE_ID, '--control-root', p.control, '--authority', first, '--json']);
    expect(stale.err).toMatch(/CONTROLLER_AUTHORITY_INVALID/);
    const fresh = await b.run(['session', 'reconcile', FEATURE_ID, '--control-root', p.control, '--authority', recovered.key!, '--json']);
    expect(fresh.code).toBe(0);

    const c = await host();
    const again = await open(c, p, ['--recover']);
    expect(again.code).not.toBe(0);
    expect(again.err).toMatch(/CONTROLLER_BUSY: .*still running/);
  });

  it('is refused while an adapter worker of the old session is still alive', async () => {
    const p = portfolio();
    const a = await host();
    const first = (await open(a, p)).key!;
    expect((await a.run(['feature', 'init', FEATURE_ID, '--control-root', p.control, '--authority', first])).code).toBe(0);
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    try {
      recordSpawn(
        featurePaths(p.control, FEATURE_ID).sessionsRegistry,
        { session_id: 'sess-live', adapter: 'claude-background', pid: worker.pid!, node_id: `${FEATURE_ID}.core.publish.impl`, claim_id: 'c-1', started_at: new Date().toISOString(), log_path: 'x.log', result_path: 'x.json' },
        { featureId: FEATURE_ID, repository: 'core', worktree: null, branch: null, attempt: 1 },
      );
      await a.kill();
      const b = await host();
      const refused = await open(b, p, ['--recover']);
      expect(refused.code).not.toBe(0);
      expect(refused.err).toMatch(/CONTROLLER_BUSY: .*sess-live/);
    } finally {
      worker.kill('SIGKILL');
      await new Promise((r) => (worker.exitCode !== null ? r(null) : worker.once('exit', r)));
    }
    const b2 = await host();
    expect((await open(b2, p, ['--recover'])).code).toBe(0);
  });

  it('a key opened outside a verifiable session is only taken over by the operator', async () => {
    const p = portfolio();
    openControllerAuthority(p.control);
    expect(record(p).holder).toBeNull();
    const b = await host();
    const refused = await open(b, p, ['--recover']);
    expect(refused.code).not.toBe(0);
    expect(refused.err).toMatch(/CONTROLLER_BUSY: .*--takeover/);
  });

  it('a fresh session without the key is told to recover, not to look for it', async () => {
    const p = portfolio();
    const a = await host();
    await open(a, p);
    const b = await host();
    const exists = await open(b, p);
    expect(exists.err).toMatch(/CONTROLLER_AUTHORITY_EXISTS: .*--recover/);
  });
});
