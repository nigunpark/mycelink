import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statusLine } from '../src/status-line.js';

test('a shipped order shows its label', () => {
  assert.equal(statusLine({ version: 1, id: 'A-1', status: 'shipped' }), 'Order A-1: Shipped');
});

test('placed and delivered orders show their labels', () => {
  assert.equal(statusLine({ version: 1, id: 'A-2', status: 'placed' }), 'Order A-2: Placed');
  assert.equal(statusLine({ version: 1, id: 'A-3', status: 'delivered' }), 'Order A-3: Delivered');
});
