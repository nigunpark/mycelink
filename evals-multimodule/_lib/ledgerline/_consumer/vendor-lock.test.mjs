import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeSha256 } from '../scripts/sync-core.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('vendored ledger-core matches its lock file', () => {
  const lock = JSON.parse(readFileSync(join(root, 'vendor', 'ledger-core.lock.json'), 'utf8'));
  assert.equal(lock.package, '@ledgerline/core');
  assert.equal(treeSha256(join(root, 'vendor', 'ledger-core')), lock.tree_sha256);
});
