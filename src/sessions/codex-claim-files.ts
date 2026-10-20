/** Claim-local mailbox. Only the controller handles requests; the worker writes numbered files. */
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChannelResponse } from './codex-claim-channel.js';
import { redactValue, type Env } from '../security/redact.js';
import { isInsideReal } from '../security/paths.js';

const MAX_REQUEST = 8 * 1024;
const MAX_RESPONSE_OUTPUT = 32 * 1024;
const MAX_REQUESTS = 64;
const NAME = /^request-([1-9][0-9]{0,2})\.json$/;

export class ClaimFileTransport {
  readonly dir: string;
  private timer: NodeJS.Timeout | null = null;
  private active = false;
  private expected = 1;
  private readonly responded = new Set<number>();

  constructor(worktree: string, claimId: string, private readonly handle: (request: unknown) => ChannelResponse, private readonly env: Env = process.env) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(claimId)) throw new Error('CHANNEL_CLAIM_INVALID');
    this.dir = join(worktree, '.mycelink-worker', `channel-${claimId}`);
  }

  start(): void {
    if (this.active || existsSync(this.dir)) throw new Error('CHANNEL_ALREADY_STARTED');
    const parent = join(this.dir, '..');
    if (!lstatSync(parent).isDirectory() || !isInsideReal(join(parent, '..'), parent)) throw new Error('CHANNEL_PATH_INVALID');
    mkdirSync(this.dir);
    this.active = true;
    this.timer = setInterval(() => { try { this.tick(); } catch { this.stop(); } }, 50);
    this.timer.unref();
  }

  tick(): void {
    if (!this.active) throw new Error('CHANNEL_STOPPED');
    if (!lstatSync(this.dir).isDirectory()) throw new Error('CHANNEL_PATH_INVALID');
    const entries = readdirSync(this.dir).map((name) => ({ name, number: NAME.exec(name)?.[1] }))
      .filter((e): e is { name: string; number: string } => e.number !== undefined)
      .sort((a, b) => Number(a.number) - Number(b.number));
    for (const { name, number } of entries) {
      const n = Number(number);
      if (this.responded.has(n)) continue;
      const requestFile = join(this.dir, name);
      let response: ChannelResponse;
      if (n > MAX_REQUESTS || n !== this.expected) {
        response = { ok: false, sequence: n, code: 'CHANNEL_SEQUENCE_INVALID' };
      } else {
        try {
          const before = lstatSync(requestFile);
          if (!before.isFile() || before.size > MAX_REQUEST) throw new Error('invalid file');
          const fd = openSync(requestFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
          let bytes: Buffer;
          try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.size > MAX_REQUEST || stat.ino !== before.ino || stat.dev !== before.dev) throw new Error('invalid descriptor');
            bytes = Buffer.alloc(MAX_REQUEST + 1);
            const count = readSync(fd, bytes, 0, bytes.length, 0);
            bytes = bytes.subarray(0, count);
            if (count > MAX_REQUEST) throw new Error('oversized request');
          } finally { closeSync(fd); }
          const parsed: unknown = JSON.parse(bytes.toString('utf8'));
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as Record<string, unknown>)['sequence'] !== n) {
            throw new Error('filename and request sequence differ');
          }
          response = this.handle(parsed);
          if (response.sequence !== n) throw new Error('handler returned a response for another sequence');
        } catch {
          response = { ok: false, sequence: n, code: 'CHANNEL_REQUEST_INVALID' };
        }
        this.expected++;
      }
      // Redact before truncating, including any diagnostic from a gate executor.
      const safe = redactValue(response, this.env);
      if (typeof safe.output === 'string') safe.output = safe.output.slice(0, MAX_RESPONSE_OUTPUT);
      const target = join(this.dir, `response-${n}.json`);
      const tmp = join(this.dir, `.response-${randomUUID()}.tmp`);
      try {
        writeFileSync(tmp, JSON.stringify(safe) + '\n', { flag: 'wx' });
        renameSync(tmp, target);
        this.responded.add(n);
      } finally { rmSync(tmp, { force: true }); }
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.active) return;
    this.active = false;
    rmSync(this.dir, { recursive: true, force: true });
  }
}
