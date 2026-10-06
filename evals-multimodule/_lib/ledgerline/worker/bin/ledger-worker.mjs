#!/usr/bin/env node
/**
 * Ledgerline background worker.
 *
 *   ledger-worker --once     drain the queue, then exit 0
 *   ledger-worker            poll forever (Ctrl+C / SIGTERM to stop)
 *
 *   LEDGER_DATA_DIR          data directory shared with ledger-api (required)
 *   LEDGER_GATEWAY_DELAY_MS  fake gateway latency (default 0)
 *
 * Several workers may run against the same data directory at once.
 */
import { openStore } from '../vendor/ledger-core/index.mjs';
import { FakeGateway } from '../src/gateway.mjs';
import { drain } from '../src/worker.mjs';

const dataDir = process.env.LEDGER_DATA_DIR;
if (!dataDir) {
  console.error('LEDGER_DATA_DIR is required');
  process.exit(2);
}
const once = process.argv.includes('--once');
const deps = { store: await openStore(dataDir), gateway: new FakeGateway({ dataDir }) };
const log = (entry) => console.log(JSON.stringify(entry));

if (once) {
  const outcomes = await drain(deps, log);
  log({ event: 'drained', processed: outcomes.length });
} else {
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => (stopping = true));
  while (!stopping) {
    await drain(deps, log);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
