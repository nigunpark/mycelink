import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice } from '../src/price.js';

test('formats whole cents as dollars', () => {
  assert.equal(formatPrice(1250), '$12.50');
  assert.equal(formatPrice(5), '$0.05');
  assert.equal(formatPrice(0), '$0.00');
});

test('refuses a negative or fractional price', () => {
  assert.throws(() => formatPrice(-1), RangeError);
  assert.throws(() => formatPrice(1.5), RangeError);
});
