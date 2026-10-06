/**
 * Delivery never destroys work it did not install, and never trusts a
 * manifest it cannot re-check.
 *
 * - Rollback used `reset --keep <before>` on a checked-out base: a commit
 *   someone made on that branch after this delivery fast-forwarded it was
 *   thrown away. Rollback is now a compare-and-swap: a base is restored
 *   only if it is still exactly at the candidate this delivery installed;
 *   otherwise it is left alone and the delivery reports PARTIAL_DELIVERY.
 * - An ACCEPTED manifest answered a repeated delivery without any check.
 *   Now its schema, its binding to the candidate and every acceptance
 *   output's hash are verified first; anything off re-runs acceptance.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTmpRoots } from '../helpers/tmp.js';
import { git } from '../helpers/git-fixture.js';
import { FEATURE_ID, type Portfolio } from '../helpers/portfolio-fixture.js';
import { cli, hostLoop, hostPortfolio } from '../helpers/host-loop.js';
import { loadCandidate } from '../../src/git/candidate.js';
import { resolveRef } from '../../src/git/git.js';

afterAll(() => cleanupTmpRoots());

const slash = (path: string): string => path.replace(/\\/g, '/');

interface DeliveryOut {
  ok: boolean;
  status: string;
  idempotent: boolean;
  acceptance: { repository: string; exit_code: number; output_path: string; output_sha256: string }[];
  error: string | null;
}

const manifestPath = (p: Portfolio): string => join(p.featureDir, 'deliveries', `${FEATURE_ID}-C001.json`);

async function deliver(p: Portfolio): Promise<{ code: number; out: DeliveryOut | null; err: string }> {
  const r = await cli(p, ['deliver', FEATURE_ID, '--json']);
  return { code: r.code, out: r.out.trim() ? (JSON.parse(r.out) as DeliveryOut) : null, err: r.err };
}

describe('delivery rollback is a compare-and-swap', () => {
  let p: Portfolio;
  beforeEach(async () => {
    p = await hostPortfolio();
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
  });

  it('never resets a base that moved after this delivery fast-forwarded it, and reports a partial delivery', async () => {
    const candidate = loadCandidate(p.featureDir, `${FEATURE_ID}-C001`);
    const before = { api: resolveRef(p.api, 'main'), core: resolveRef(p.core, 'main'), web: resolveRef(p.app, 'main') };
    // Order is api, core, web. api and core fast-forward; when web is about
    // to move, someone commits on core's main, and web's update then fails.
    const marker = join(p.root, 'concurrent.done');
    const hook = join(p.app, '.git', 'hooks', 'reference-transaction');
    writeFileSync(
      hook,
      [
        '#!/bin/sh',
        'if [ "$1" = prepared ] && [ ! -f "' + slash(marker) + '" ]; then',
        '  unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX',
        '  git -C "' + slash(p.core) + '" commit --allow-empty -q -m "concurrent work on main" || exit 1',
        '  : > "' + slash(marker) + '"',
        '  exit 1',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
    );
    chmodSync(hook, 0o755);

    const r = await deliver(p);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/PARTIAL_DELIVERY/);
    expect(r.err).toMatch(/core/);

    // The concurrent commit survives, on top of the candidate.
    const coreNow = resolveRef(p.core, 'main');
    expect(coreNow).not.toBe(candidate.repositories['core']!.sha);
    expect(coreNow).not.toBe(before.core);
    expect(git(p.core, ['log', '-1', '--format=%s', 'main'])).toBe('concurrent work on main');
    expect(git(p.core, ['rev-parse', 'main~1'])).toBe(candidate.repositories['core']!.sha);
    // What only this delivery moved is put back; the failed one never moved.
    expect(resolveRef(p.api, 'main')).toBe(before.api);
    expect(git(p.api, ['status', '--porcelain'])).toBe('');
    expect(resolveRef(p.app, 'main')).toBe(before.web);

    const manifest = JSON.parse(readFileSync(manifestPath(p), 'utf8')) as DeliveryOut;
    expect(manifest.status).toBe('PARTIAL_DELIVERY');
    expect(manifest.error).toMatch(/core.*(moved|manual)/);

    // A retry refuses rather than touching core again.
    rmSync(hook);
    git(p.app, ['reset', '-q', '--hard', 'main']);
    const again = await deliver(p);
    expect(again.code).not.toBe(0);
    expect(again.err).toMatch(/NON_FAST_FORWARD: core/);
    expect(resolveRef(p.core, 'main')).toBe(coreNow);
  });

  it('still restores a checked-out base that nobody touched, files included', async () => {
    const before = resolveRef(p.api, 'main');
    writeFileSync(join(p.app, '.git', 'index.lock'), '');
    const r = await deliver(p);
    expect(r.err).toMatch(/DELIVERY_FAILED/);
    expect(r.err).not.toMatch(/PARTIAL_DELIVERY/);
    expect(resolveRef(p.api, 'main')).toBe(before);
    expect(git(p.api, ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(p.api, 'src', 'consume.js'))).toBe(false);
    expect((JSON.parse(readFileSync(manifestPath(p), 'utf8')) as DeliveryOut).status).toBe('ROLLED_BACK');
  });
});

describe('an ACCEPTED manifest is verified before it is trusted', () => {
  let p: Portfolio;
  beforeEach(async () => {
    p = await hostPortfolio();
    expect((await hostLoop(p)).status).toBe('ALL_SETTLED');
    expect((await deliver(p)).out?.status).toBe('ACCEPTED');
  });

  const tamper = (p: Portfolio, edit: (m: Record<string, unknown>) => void): void => {
    const m = JSON.parse(readFileSync(manifestPath(p), 'utf8')) as Record<string, unknown>;
    edit(m);
    writeFileSync(manifestPath(p), JSON.stringify(m, null, 2));
  };

  it('an intact manifest still answers a repeated delivery', async () => {
    expect((await deliver(p)).out).toMatchObject({ ok: true, idempotent: true, status: 'ACCEPTED' });
  });

  const cases: [string, (p: Portfolio) => void][] = [
    ['an acceptance output whose content changed', (p) => {
      const m = JSON.parse(readFileSync(manifestPath(p), 'utf8')) as DeliveryOut;
      writeFileSync(join(p.control, m.acceptance[0]!.output_path), 'all good, trust me\n');
    }],
    ['a missing acceptance output', (p) => {
      const m = JSON.parse(readFileSync(manifestPath(p), 'utf8')) as DeliveryOut;
      rmSync(join(p.control, m.acceptance[0]!.output_path));
    }],
    ['a forged output hash', (p) => tamper(p, (m) => {
      (m['acceptance'] as { output_sha256: string }[])[0]!.output_sha256 = 'f'.repeat(64);
    })],
    ['a dropped acceptance record', (p) => tamper(p, (m) => {
      (m['acceptance'] as unknown[]).pop();
    })],
    ['a failed acceptance relabelled', (p) => tamper(p, (m) => {
      const a = (m['acceptance'] as { exit_code: number; failure_fingerprint: string | null }[])[0]!;
      a.exit_code = 1;
    })],
    ['an output path outside the feature', (p) => tamper(p, (m) => {
      (m['acceptance'] as { output_path: string }[])[0]!.output_path = '../outside.txt';
    })],
    ['a manifest for another candidate', (p) => tamper(p, (m) => {
      m['candidate_id'] = `${FEATURE_ID}-C999`;
    })],
    ['a malformed manifest', (p) => tamper(p, (m) => {
      delete m['repositories'];
    })],
    ['an acceptance record for another commit', (p) => tamper(p, (m) => {
      (m['acceptance'] as { sha: string }[])[0]!.sha = '0'.repeat(40);
    })],
  ];

  for (const [label, damage] of cases) {
    it(`${label} forces acceptance to run again instead of being trusted`, async () => {
      damage(p);
      const r = await deliver(p);
      expect(r.err).toBe('');
      expect(r.out).toMatchObject({ ok: true, idempotent: false, status: 'ACCEPTED' });
      expect(r.out!.acceptance.map((a) => [a.repository, a.exit_code])).toEqual([
        ['api', 0],
        ['core', 0],
        ['web', 0],
      ]);
      for (const a of r.out!.acceptance) expect(existsSync(join(p.control, a.output_path))).toBe(true);
      // And the re-checked manifest is trusted again.
      expect((await deliver(p)).out).toMatchObject({ idempotent: true });
    });
  }

  it('acceptance that fails on re-run is reported, not hidden behind the old manifest', async () => {
    tamper(p, (m) => {
      (m['acceptance'] as { output_sha256: string }[])[0]!.output_sha256 = 'e'.repeat(64);
    });
    // The api's delivered tests now fail: the contract they read moved on.
    const moved = join(p.root, 'order-status.v3.json');
    writeFileSync(moved, JSON.stringify({ name: 'order-status', version: 3 }));
    process.env['CONTRACT_PATH'] = moved;
    let r: Awaited<ReturnType<typeof deliver>>;
    try {
      r = await deliver(p);
    } finally {
      delete process.env['CONTRACT_PATH'];
    }
    expect(r.code).not.toBe(0);
    expect(r.out).toMatchObject({ ok: false, idempotent: false, status: 'ACCEPTANCE_FAILED' });
    expect(r.out!.acceptance.find((a) => a.repository === 'api')!.exit_code).not.toBe(0);
  });
});
