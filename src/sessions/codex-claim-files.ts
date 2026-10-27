/** Claim-local mailbox. Only the controller handles requests; the worker writes numbered files. */
import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { boundChannelResponse, validProbeDiagnostic, type ChannelResponse } from './codex-claim-channel.js';
import { redactValue, type Env } from '../security/redact.js';
import { isInsideReal, readRegular } from '../security/paths.js';

const MAX_REQUEST = 8 * 1024;
const MAX_REQUESTS = 64;
const NAME = /^request-([1-9][0-9]{0,2})\.json$/;

/** The worker gets no host path, capability or verifier argv: only this local request client. */
function clientSource(identity: { claimId: string; featureId: string; nodeId: string }): string {
  return `import { existsSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
const dir = dirname(fileURLToPath(import.meta.url));
const [operation, ...args] = process.argv.slice(2);
const identity = ${JSON.stringify(identity)};
let payload;
if (operation === 'gate' && args.length === 1 && ['red', 'green', 'regression'].includes(args[0])) payload = { operation, gate: args[0] };
else if (operation === 'commit' && args.length >= 2 && args.length <= 101) payload = { operation, message: args[0], paths: args.slice(1) };
else if (operation === 'challenge' && args.length === 1 && /^AC-[A-Za-z0-9_.-]{1,60}$/.test(args[0])) payload = { operation, criterion: args[0] };
else if ((operation === 'check' || operation === 'probe') && args.length === 0) payload = { operation };
else throw new Error('CHANNEL_CLIENT_USAGE');
const numbers = readdirSync(dir).map(x => /^request-([1-9][0-9]{0,2})\\.json$/.exec(x)).filter(Boolean).map(x => Number(x[1]));
const sequence = Math.max(0, ...numbers) + 1;
if (sequence > 64) throw new Error('CHANNEL_LIMIT');
const request = JSON.stringify({ ...identity, sequence, ...payload });
if (Buffer.byteLength(request) > 8192) throw new Error('CHANNEL_REQUEST_TOO_LARGE');
const pending = join(dir, '.request-' + sequence + '-' + process.pid + '.tmp');
writeFileSync(pending, request, { flag: 'wx' });
renameSync(pending, join(dir, 'request-' + sequence + '.json'));
const response = join(dir, 'response-' + sequence + '.json');
let answer;
for (let i = 0; i < 12000; i++) {
  try { answer = JSON.parse(readFileSync(response, 'utf8')); break; }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  if (!existsSync(dir)) throw new Error('CHANNEL_STOPPED');
  await sleep(50);
}
if (!answer || answer.sequence !== sequence) throw new Error('CHANNEL_RESPONSE_TIMEOUT');
console.log(JSON.stringify(answer));
if (!answer.ok) process.exitCode = 1;
`;
}

export class ClaimFileTransport {
  readonly dir: string;
  private timer: NodeJS.Timeout | null = null;
  private active = false;
  private expected = 1;
  private readonly responded = new Set<number>();
  private readonly incompleteSince = new Map<number, number>();

  constructor(worktree: string, private readonly claimId: string, private readonly handle: (request: unknown) => ChannelResponse, private readonly env: Env = process.env,
    private readonly identity: { featureId: string; nodeId: string } = { featureId: '', nodeId: '' }) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(claimId)) throw new Error('CHANNEL_CLAIM_INVALID');
    if (identity.featureId && !/^[A-Za-z0-9_.-]{1,128}$/.test(identity.featureId)) throw new Error('CHANNEL_IDENTITY_INVALID');
    if (identity.nodeId && !/^[A-Za-z0-9_.-]{1,128}$/.test(identity.nodeId)) throw new Error('CHANNEL_IDENTITY_INVALID');
    this.dir = join(worktree, '.mycelink-worker', `channel-${claimId}`);
  }

  start(): void {
    if (this.active || existsSync(this.dir)) throw new Error('CHANNEL_ALREADY_STARTED');
    const parent = join(this.dir, '..');
    if (!lstatSync(parent).isDirectory() || !isInsideReal(join(parent, '..'), parent)) throw new Error('CHANNEL_PATH_INVALID');
    mkdirSync(this.dir);
    try { writeFileSync(join(this.dir, 'client.mjs'), clientSource({ claimId: this.claimId, ...this.identity }), { flag: 'wx' }); }
    catch (err) { rmSync(this.dir, { recursive: true, force: true }); throw err; }
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
          // Open once, compare the opened file with its current path, and read
          // through that descriptor. A swapped link or oversized request fails.
          const observed = readRegular(requestFile, MAX_REQUEST);
          if (!observed) throw new Error('invalid request file');
          const bytes = observed.bytes;
          let parsed: unknown;
          try { parsed = JSON.parse(bytes.toString('utf8')); }
          catch (err) {
            // A legacy/in-flight writer may expose the filename before its
            // write completes. Bound the grace period for malformed JSON.
            const since = this.incompleteSince.get(n) ?? Date.now();
            this.incompleteSince.set(n, since);
            if (err instanceof SyntaxError && Date.now() - since < 1_000) continue;
            throw err;
          }
          this.incompleteSince.delete(n);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as Record<string, unknown>)['sequence'] !== n) {
            throw new Error('filename and request sequence differ');
          }
          try { response = this.handle(parsed); }
          catch { response = { ok: false, sequence: n, code: 'CHANNEL_HANDLER_FAILED' }; }
          if (response.sequence !== n) throw new Error('handler returned a response for another sequence');
        } catch {
          response = { ok: false, sequence: n, code: 'CHANNEL_REQUEST_INVALID' };
        }
        this.expected++;
      }
      // Redact before truncating, including any diagnostic from a gate executor.
      let safe: ChannelResponse;
      if ('diagnostic' in response && response.diagnostic !== undefined && !validProbeDiagnostic(response.diagnostic)) {
        safe = boundChannelResponse(response);
      } else {
        const redacted = redactValue(response, this.env);
        // Redacted identities no longer bind the original canonical test IDs.
        // Refuse even when the changed diagnostic still passes shape validation.
        safe = 'diagnostic' in response && 'diagnostic' in redacted &&
          JSON.stringify(redacted.diagnostic) !== JSON.stringify(response.diagnostic)
          ? { ok: true, sequence: n, exitCode: 2, output: 'CHANNEL_PROBE_REPORT_INVALID:REDACTION' }
          : boundChannelResponse(redacted);
      }
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
