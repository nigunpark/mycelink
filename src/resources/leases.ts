/**
 * Resource leases.
 *
 * The full runtime and deploy slot are capacity-1 by policy: only one
 * integration server can exist at a time. Browser workers and other pooled
 * resources use declared capacities. Every grant is persisted so a crashed
 * holder can be recovered rather than deadlocking the feature.
 */
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ResourceDecl } from '../model/types.js';
import { readDoc, writeDocAtomic } from '../state/atomic-json.js';
import { isPidAlive, withLock } from '../state/process-lock.js';

export interface Lease {
  lease_id: string;
  resource: string;
  node_id: string;
  owner: string;
  pid: number;
  host: string;
  acquired_at: string;
  ttl_ms: number;
  idempotency_key?: string;
}

interface LeaseFile {
  schema_version: 1;
  leases: Lease[];
  /**
   * Resources this feature has ever leased. Kept so `leaseStatus` can report
   * "held: 0" for a freed resource instead of silently omitting it — a
   * reconciliation report must distinguish "free" from "never existed".
   */
  known_resources?: string[];
}

export class ResourceBusyError extends Error {
  readonly resource: string;
  readonly capacity: number;
  readonly holders: string[];
  constructor(resource: string, capacity: number, holders: string[]) {
    super(
      `Resource "${resource}" is at capacity ${capacity}; held by ${holders.join(', ') || '(unknown)'}`,
    );
    this.name = 'ResourceBusyError';
    this.resource = resource;
    this.capacity = capacity;
    this.holders = holders;
  }
}

export interface AcquireOptions {
  nodeId: string;
  owner: string;
  capacities: Record<string, ResourceDecl | { capacity: number }>;
  ttlMs?: number;
  /** A repeated acquire with the same key returns the existing lease. */
  idempotencyKey?: string;
  pid?: number;
  now?: number;
}

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

function leaseFilePath(featureDir: string): string {
  return join(featureDir, 'leases.json');
}

function lockPath(featureDir: string): string {
  return join(featureDir, 'leases.json.lock');
}

function load(featureDir: string): LeaseFile {
  const doc = readDoc<LeaseFile>(leaseFilePath(featureDir));
  return doc?.data ?? { schema_version: 1, leases: [], known_resources: [] };
}

function save(featureDir: string, file: LeaseFile, alsoKnown: string[] = []): void {
  const known = new Set([...(file.known_resources ?? []), ...alsoKnown]);
  for (const lease of file.leases) known.add(lease.resource);
  writeDocAtomic(leaseFilePath(featureDir), {
    schema_version: 1,
    leases: file.leases,
    known_resources: [...known].sort(),
  });
}

/** Leases whose holder is gone or whose TTL expired. */
function expired(lease: Lease, now: number): boolean {
  if (Date.parse(lease.acquired_at) + lease.ttl_ms <= now) return true;
  if (lease.host === hostname() && !isPidAlive(lease.pid)) return true;
  return false;
}

function prune(file: LeaseFile, now: number): { kept: Lease[]; removed: Lease[] } {
  const kept: Lease[] = [];
  const removed: Lease[] = [];
  for (const lease of file.leases) {
    if (expired(lease, now)) removed.push(lease);
    else kept.push(lease);
  }
  return { kept, removed };
}

/** Acquire one unit of `resource`, or throw {@link ResourceBusyError}. */
export function acquireResource(
  featureDir: string,
  resource: string,
  options: AcquireOptions,
): Lease {
  const now = options.now ?? Date.now();
  const capacity = options.capacities[resource]?.capacity;
  if (capacity === undefined) {
    throw new Error(`Resource "${resource}" has no declared capacity.`);
  }

  return withLock(
    lockPath(featureDir),
    (): Lease => {
      const file = load(featureDir);
      const { kept } = prune(file, now);

      if (options.idempotencyKey) {
        const existing = kept.find((l) => l.idempotency_key === options.idempotencyKey);
        if (existing) {
          save(featureDir, { ...file, leases: kept });
          return existing;
        }
      }

      const held = kept.filter((l) => l.resource === resource);
      if (held.length + 1 > capacity) {
        save(featureDir, { ...file, leases: kept });
        throw new ResourceBusyError(
          resource,
          capacity,
          held.map((l) => `${l.node_id}/${l.owner}`),
        );
      }

      const lease: Lease = {
        lease_id: randomUUID(),
        resource,
        node_id: options.nodeId,
        owner: options.owner,
        pid: options.pid ?? process.pid,
        host: hostname(),
        acquired_at: new Date(now).toISOString(),
        ttl_ms: options.ttlMs ?? DEFAULT_TTL_MS,
        ...(options.idempotencyKey ? { idempotency_key: options.idempotencyKey } : {}),
      };
      save(featureDir, { ...file, leases: [...kept, lease] }, [resource]);
      return lease;
    },
    { timeoutMs: 15_000, pollMs: 10, purpose: 'resource lease' },
  );
}

/** Release one lease by id. Unknown ids are a no-op (idempotent cleanup). */
export function releaseResource(featureDir: string, leaseId: string): boolean {
  return withLock(
    lockPath(featureDir),
    (): boolean => {
      const file = load(featureDir);
      const before = file.leases.length;
      const leases = file.leases.filter((l) => l.lease_id !== leaseId);
      save(featureDir, { ...file, leases });
      return leases.length !== before;
    },
    { timeoutMs: 15_000, pollMs: 10, purpose: 'resource release' },
  );
}

/** Release every lease held for a node; used when a claim ends or crashes. */
export function releaseAllForNode(featureDir: string, nodeId: string): Lease[] {
  return withLock(
    lockPath(featureDir),
    (): Lease[] => {
      const file = load(featureDir);
      const released = file.leases.filter((l) => l.node_id === nodeId);
      save(featureDir, { ...file, leases: file.leases.filter((l) => l.node_id !== nodeId) });
      return released;
    },
    { timeoutMs: 15_000, pollMs: 10, purpose: 'resource release-node' },
  );
}

/** Reclaim leases from dead holders or past their TTL. */
export function recoverLeases(featureDir: string, now = Date.now()): Lease[] {
  return withLock(
    lockPath(featureDir),
    (): Lease[] => {
      const file = load(featureDir);
      const { kept, removed } = prune(file, now);
      if (removed.length > 0) {
        save(
          featureDir,
          { ...file, leases: kept },
          removed.map((l) => l.resource),
        );
      }
      return removed;
    },
    { timeoutMs: 15_000, pollMs: 10, purpose: 'resource recover' },
  );
}

export interface ResourceStatus {
  held: number;
  holders: { lease_id: string; node_id: string; owner: string; acquired_at: string }[];
}

/** Current occupancy per resource (after pruning expired leases from view). */
export function leaseStatus(featureDir: string, now = Date.now()): Record<string, ResourceStatus> {
  const file = load(featureDir);
  const { kept } = prune(file, now);
  const out: Record<string, ResourceStatus> = {};
  for (const resource of file.known_resources ?? []) {
    out[resource] = { held: 0, holders: [] };
  }
  for (const lease of kept) {
    const entry = (out[lease.resource] ??= { held: 0, holders: [] });
    entry.held += 1;
    entry.holders.push({
      lease_id: lease.lease_id,
      node_id: lease.node_id,
      owner: lease.owner,
      acquired_at: lease.acquired_at,
    });
  }
  return out;
}

/** All live leases, for reconciliation and status reporting. */
export function listLeases(featureDir: string, now = Date.now()): Lease[] {
  return prune(load(featureDir), now).kept;
}
