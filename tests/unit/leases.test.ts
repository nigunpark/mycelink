import { afterAll, describe, expect, it } from 'vitest';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { makeTmpDir, cleanupTmpRoots } from '../helpers/tmp.js';
import {
  ResourceBusyError,
  acquireResource,
  leaseStatus,
  recoverLeases,
  releaseResource,
  releaseAllForNode,
} from '../../src/resources/leases.js';

afterAll(() => cleanupTmpRoots());

const DIST = resolve(process.cwd(), 'dist');
const CAPACITIES = { 'full-runtime': { capacity: 1 }, 'browser-worker': { capacity: 2 } };

describe('resource leases', () => {
  it('grants a lease within capacity and reports it', () => {
    const dir = makeTmpDir('lease-');
    const lease = acquireResource(dir, 'full-runtime', {
      nodeId: 'N1',
      capacities: CAPACITIES,
      owner: 'test',
    });
    expect(lease.resource).toBe('full-runtime');
    expect(leaseStatus(dir)['full-runtime']?.held).toBe(1);
  });

  it('refuses a second lease on a capacity-1 resource', () => {
    const dir = makeTmpDir('lease-');
    acquireResource(dir, 'full-runtime', { nodeId: 'N1', capacities: CAPACITIES, owner: 'a' });
    expect(() =>
      acquireResource(dir, 'full-runtime', { nodeId: 'N2', capacities: CAPACITIES, owner: 'b' }),
    ).toThrow(ResourceBusyError);
  });

  it('allows capacity-2 resources to be held twice but not three times', () => {
    const dir = makeTmpDir('lease-');
    acquireResource(dir, 'browser-worker', { nodeId: 'N1', capacities: CAPACITIES, owner: 'a' });
    acquireResource(dir, 'browser-worker', { nodeId: 'N2', capacities: CAPACITIES, owner: 'b' });
    expect(() =>
      acquireResource(dir, 'browser-worker', { nodeId: 'N3', capacities: CAPACITIES, owner: 'c' }),
    ).toThrow(ResourceBusyError);
  });

  it('frees capacity on release', () => {
    const dir = makeTmpDir('lease-');
    const lease = acquireResource(dir, 'full-runtime', {
      nodeId: 'N1',
      capacities: CAPACITIES,
      owner: 'a',
    });
    releaseResource(dir, lease.lease_id);
    expect(leaseStatus(dir)['full-runtime']?.held).toBe(0);
    expect(() =>
      acquireResource(dir, 'full-runtime', { nodeId: 'N2', capacities: CAPACITIES, owner: 'b' }),
    ).not.toThrow();
  });

  it('releasing an unknown lease id is a harmless no-op', () => {
    const dir = makeTmpDir('lease-');
    expect(() => releaseResource(dir, 'nope')).not.toThrow();
  });

  it('is idempotent for a repeated acquire with the same idempotency key', () => {
    const dir = makeTmpDir('lease-');
    const a = acquireResource(dir, 'full-runtime', {
      nodeId: 'N1',
      capacities: CAPACITIES,
      owner: 'a',
      idempotencyKey: 'k1',
    });
    const b = acquireResource(dir, 'full-runtime', {
      nodeId: 'N1',
      capacities: CAPACITIES,
      owner: 'a',
      idempotencyKey: 'k1',
    });
    expect(b.lease_id).toBe(a.lease_id);
    expect(leaseStatus(dir)['full-runtime']?.held).toBe(1);
  });

  it('recovers leases whose holder process is gone', () => {
    const dir = makeTmpDir('lease-');
    const file = join(dir, 'leases.json');
    writeFileSync(
      file,
      JSON.stringify({
        revision: 1,
        data: {
          schema_version: 1,
          leases: [
            {
              lease_id: 'ghost',
              resource: 'full-runtime',
              node_id: 'N1',
              owner: 'dead-worker',
              pid: 2147483646,
              host: hostname(),
              acquired_at: new Date().toISOString(),
              ttl_ms: 3_600_000,
            },
          ],
        },
      }),
    );

    const recovered = recoverLeases(dir);
    expect(recovered.map((l) => l.lease_id)).toEqual(['ghost']);
    expect(leaseStatus(dir)['full-runtime']?.held).toBe(0);
  });

  it('recovers leases older than their TTL', () => {
    const dir = makeTmpDir('lease-');
    acquireResource(dir, 'full-runtime', {
      nodeId: 'N1',
      capacities: CAPACITIES,
      owner: 'a',
      ttlMs: 10,
    });
    const recovered = recoverLeases(dir, Date.now() + 1000);
    expect(recovered).toHaveLength(1);
    expect(leaseStatus(dir)['full-runtime']?.held).toBe(0);
  });

  it('releases every lease held by a node when its claim ends', () => {
    const dir = makeTmpDir('lease-');
    acquireResource(dir, 'full-runtime', { nodeId: 'N1', capacities: CAPACITIES, owner: 'a' });
    acquireResource(dir, 'browser-worker', { nodeId: 'N1', capacities: CAPACITIES, owner: 'a' });
    acquireResource(dir, 'browser-worker', { nodeId: 'N2', capacities: CAPACITIES, owner: 'b' });

    const released = releaseAllForNode(dir, 'N1');
    expect(released).toHaveLength(2);
    expect(leaseStatus(dir)['full-runtime']?.held).toBe(0);
    expect(leaseStatus(dir)['browser-worker']?.held).toBe(1);
  });

  it('never issues a capacity-1 lease twice under concurrent OS processes', async () => {
    const dir = makeTmpDir('lease-mp-');
    const modUrl = pathToFileURL(join(DIST, 'resources', 'leases.js')).href;
    const script = join(dir, 'grab.mjs');
    const outDir = join(dir, 'out');
    writeFileSync(
      script,
      `
import { acquireResource } from ${JSON.stringify(modUrl)};
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, outDir, tag] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
let got = 0;
try {
  acquireResource(dir, 'full-runtime', {
    nodeId: tag,
    capacities: { 'full-runtime': { capacity: 1 } },
    owner: tag,
  });
  got = 1;
} catch { got = 0; }
writeFileSync(join(outDir, tag + '.json'), JSON.stringify({ got }));
// Stay alive while the other contenders run: a lease belongs to a LIVE
// holder, and an exited process legitimately has its lease reclaimed.
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
`,
    );

    const n = 6;
    await Promise.all(
      Array.from(
        { length: n },
        (_, i) =>
          new Promise<void>((ok, fail) => {
            const child = spawn(process.execPath, [script, dir, outDir, `w${i}`], {
              stdio: ['ignore', 'ignore', 'pipe'],
            });
            let stderr = '';
            child.stderr.on('data', (c: Buffer) => {
              stderr += c.toString();
            });
            child.on('error', fail);
            child.on('exit', (code) =>
              code === 0 ? ok() : fail(new Error(`child exit ${code}: ${stderr}`)),
            );
          }),
      ),
    );

    let granted = 0;
    for (let i = 0; i < n; i++) {
      granted += (JSON.parse(readFileSync(join(outDir, `w${i}.json`), 'utf8')) as { got: number })
        .got;
    }
    expect(granted).toBe(1);
    // Exactly one lease record was ever persisted for the capacity-1 resource.
    const raw = JSON.parse(readFileSync(join(dir, 'leases.json'), 'utf8')) as {
      data: { leases: { resource: string }[] };
    };
    expect(raw.data.leases.filter((l) => l.resource === 'full-runtime')).toHaveLength(1);
    // Now that every holder has exited, the lease is reclaimable.
    expect(recoverLeases(dir)).toHaveLength(1);
    expect(leaseStatus(dir)['full-runtime']?.held).toBe(0);
  });
});
