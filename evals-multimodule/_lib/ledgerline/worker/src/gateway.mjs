/**
 * Fake payment gateway used in every non-production environment.
 *
 * Each call is appended to <dataDir>/gateway/calls.jsonl, one JSON object per
 * line: { op, ref, amount_cents, outcome, at }. Reconciliation and the
 * at-most-once audits read that file, so every money movement must go
 * through here exactly once.
 *
 * Deterministic declines: any amount whose value modulo 1000 is 13
 * (13, 1013, 2013, ...) is declined with "card_declined".
 *
 * LEDGER_GATEWAY_DELAY_MS adds latency to each call (default 0).
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isDeclined(amountCents) {
  return amountCents % 1000 === 13;
}

export class FakeGateway {
  constructor({ dataDir, delayMs = Number(process.env.LEDGER_GATEWAY_DELAY_MS ?? 0) }) {
    this.dir = join(dataDir, 'gateway');
    this.delayMs = delayMs;
  }

  async record(op, ref, amount_cents, outcome) {
    await mkdir(this.dir, { recursive: true });
    const line = JSON.stringify({ op, ref, amount_cents, outcome, at: new Date().toISOString() });
    await appendFile(join(this.dir, 'calls.jsonl'), line + '\n', 'utf8');
  }

  /** Charge the customer. Returns { ok, gateway_ref } or { ok: false, decline_code }. */
  async capture({ ref, amount_cents }) {
    if (this.delayMs > 0) await sleep(this.delayMs);
    if (isDeclined(amount_cents)) {
      await this.record('capture', ref, amount_cents, 'declined');
      return { ok: false, decline_code: 'card_declined' };
    }
    await this.record('capture', ref, amount_cents, 'approved');
    return { ok: true, gateway_ref: `gw_cap_${createHash('sha256').update(ref).digest('hex').slice(0, 16)}` };
  }
}
