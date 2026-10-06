#!/usr/bin/env node
/**
 * Start the Ledgerline API.
 *
 *   LEDGER_DATA_DIR  data directory shared with ledger-worker (required)
 *   LEDGER_PORT      port to listen on (default 8080; 0 picks a free port)
 *   LEDGER_HOST      interface (default 127.0.0.1)
 *
 * Prints one JSON line {"event":"listening","url":...} once ready.
 */
import { openStore } from '../vendor/ledger-core/index.mjs';
import { createApp } from '../src/app.mjs';

const dataDir = process.env.LEDGER_DATA_DIR;
if (!dataDir) {
  console.error('LEDGER_DATA_DIR is required');
  process.exit(2);
}
const port = Number(process.env.LEDGER_PORT ?? 8080);
const host = process.env.LEDGER_HOST ?? '127.0.0.1';

const store = await openStore(dataDir);
const server = createApp({ store });
server.listen(port, host, () => {
  const address = server.address();
  console.log(JSON.stringify({ event: 'listening', url: `http://${host}:${address.port}` }));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
