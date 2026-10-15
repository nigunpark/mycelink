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

test('a delayed order shows its new expected date', () => {
  assert.equal(statusLine({ version: 2, id: 'A-7', status: 'delayed', eta: '2026-11-03' }), 'Order A-7: Delayed, now expected 2026-11-03');
});

test('an unknown status shows Status unavailable', () => {
  assert.equal(statusLine({ version: 2, id: 'A-9', status: 'returned' }), 'Order A-9: Status unavailable');
});

test('a payload without a status shows Status unavailable', () => {
  assert.equal(statusLine({ version: 2, id: 'A-10' }), 'Order A-10: Status unavailable');
});
