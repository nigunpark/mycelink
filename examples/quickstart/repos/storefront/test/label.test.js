import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productLabel } from '../src/label.js';

test('labels a product with its name and price', () => {
  assert.equal(productLabel({ name: 'Mug', price_cents: 1250 }), 'Mug: $12.50');
  assert.equal(productLabel({ name: 'Pin', price_cents: 99 }), 'Pin: $0.99');
});
