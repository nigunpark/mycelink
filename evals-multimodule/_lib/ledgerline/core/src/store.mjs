/**
 * File-backed store shared by the API and the worker.
 *
 * Several processes (API instances, workers) may open the same data
 * directory at once, so:
 *   - documents are replaced atomically (write temp file, then rename);
 *   - cross-process mutual exclusion uses `withLock`, a mkdir-based lock;
 *   - queue jobs are claimed by renaming pending -> claimed, which only one
 *     process can win.
 *
 * Layout under LEDGER_DATA_DIR:
 *   orders/<order_id>.json        order documents
 *   events/<order_id>.jsonl       append-only domain events per order
 *   queue/{pending,claimed,done,dead}/<seq>-<job_id>.json
 *   idempotency/<scope>/<sha256(key)>.json
 *   locks/<name>.lock/            held locks
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

const STALE_LOCK_MS = 30_000;
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function retrying(fn, attempts = 20) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (error) {
      // Windows refuses to replace a file another process has open for a
      // moment; that is transient, not a failure.
      if (i >= attempts || !RETRYABLE.has(error?.code)) throw error;
      await sleep(5 + i * 5);
    }
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await retrying(() => readFile(path, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await retrying(() => rename(tmp, path));
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '_');
}

export function keyHash(key) {
  return createHash('sha256').update(String(key)).digest('hex');
}

export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.seq = 0;
  }

  async init() {
    for (const sub of [
      'orders',
      'events',
      'locks',
      'idempotency',
      join('queue', 'pending'),
      join('queue', 'claimed'),
      join('queue', 'done'),
      join('queue', 'dead'),
    ]) {
      await mkdir(join(this.dir, sub), { recursive: true });
    }
    return this;
  }

  /**
   * Run `fn` while holding the named cross-process lock. Locks are not
   * re-entrant; always take them in the order idempotency -> order.
   */
  async withLock(name, fn, { timeoutMs = 15_000 } = {}) {
    const lockDir = join(this.dir, 'locks', `${safeName(name)}.lock`);
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; ; attempt++) {
      try {
        await mkdir(lockDir);
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST' && !RETRYABLE.has(error?.code)) throw error;
        const info = await stat(lockDir).catch(() => null);
        if (info && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() > deadline) throw new Error(`timed out waiting for lock ${name}`);
        await sleep(2 + Math.floor(Math.random() * 8) + Math.min(attempt, 20));
      }
    }
    try {
      return await fn();
    } finally {
      await retrying(() => rmdir(lockDir)).catch(() => {});
    }
  }

  orderPath(orderId) {
    return join(this.dir, 'orders', `${safeName(orderId)}.json`);
  }

  async readOrder(orderId) {
    return readJson(this.orderPath(orderId));
  }

  async writeOrder(order) {
    await writeJsonAtomic(this.orderPath(order.order_id), order);
  }

  /** Append one event to the order's stream. Call while holding the order lock. */
  async appendEvent(event) {
    const orderId = event?.data?.order_id;
    if (typeof orderId !== 'string') throw new Error('event data must carry order_id');
    await appendFile(join(this.dir, 'events', `${safeName(orderId)}.jsonl`), JSON.stringify(event) + '\n', 'utf8');
  }

  async listEvents(orderId) {
    let text;
    try {
      text = await readFile(join(this.dir, 'events', `${safeName(orderId)}.jsonl`), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    return text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line));
  }

  nextJobName(jobId) {
    this.seq += 1;
    const stamp = String(Date.now()).padStart(15, '0');
    return `${stamp}-${String(this.seq).padStart(6, '0')}-${process.pid}-${safeName(jobId)}.json`;
  }

  /** Enqueue a job. `job.type` selects the worker handler. */
  async enqueue(job) {
    const full = { job_id: `job_${randomUUID()}`, enqueued_at: new Date().toISOString(), attempt: 1, ...job };
    await writeJsonAtomic(join(this.dir, 'queue', 'pending', this.nextJobName(full.job_id)), full);
    return full;
  }

  /**
   * Claim the oldest pending job, or null. Safe across processes.
   *
   * The claim is an exclusive-create marker, not a rename: on Windows two
   * processes renaming the same file can both be told they succeeded.
   */
  async claimJob() {
    const pendingDir = join(this.dir, 'queue', 'pending');
    const names = (await readdir(pendingDir)).filter((n) => n.endsWith('.json')).sort();
    for (const name of names) {
      const marker = join(this.dir, 'queue', 'claimed', `${name}.claim`);
      try {
        await writeFile(marker, String(process.pid), { flag: 'wx' });
      } catch (error) {
        if (error?.code === 'EEXIST' || RETRYABLE.has(error?.code)) continue; // another process won
        throw error;
      }
      const claimed = join(this.dir, 'queue', 'claimed', name);
      try {
        await retrying(() => rename(join(pendingDir, name), claimed));
      } catch (error) {
        await rm(marker, { force: true });
        if (error?.code === 'ENOENT') continue; // finished by its owner before we got here
        throw error;
      }
      const job = await readJson(claimed);
      return { path: claimed, marker, name, job };
    }
    return null;
  }

  async finishJob(claim, outcome = 'done') {
    const target = outcome === 'dead' ? 'dead' : 'done';
    await retrying(() => rename(claim.path, join(this.dir, 'queue', target, claim.name)));
    await rm(claim.marker, { force: true });
  }

  /**
   * Operational replay: move every finished job back to pending, as a broker
   * would after an incident. Handlers must therefore be idempotent.
   */
  async redeliverAll() {
    const doneDir = join(this.dir, 'queue', 'done');
    let count = 0;
    for (const name of (await readdir(doneDir)).filter((n) => n.endsWith('.json')).sort()) {
      const job = await readJson(join(doneDir, name));
      if (job === null) continue;
      const again = { ...job, attempt: (job.attempt ?? 1) + 1 };
      await writeJsonAtomic(join(this.dir, 'queue', 'pending', this.nextJobName(job.job_id)), again);
      await rm(join(doneDir, name), { force: true });
      count += 1;
    }
    return count;
  }

  async readIdempotency(scope, key) {
    return readJson(join(this.dir, 'idempotency', safeName(scope), `${keyHash(key)}.json`));
  }

  async writeIdempotency(scope, key, record) {
    await mkdir(join(this.dir, 'idempotency', safeName(scope)), { recursive: true });
    await writeJsonAtomic(join(this.dir, 'idempotency', safeName(scope), `${keyHash(key)}.json`), record);
  }
}

export async function openStore(dataDir) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('a data directory is required');
  return new Store(dataDir).init();
}
