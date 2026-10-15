import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toStatusPayload } from '../src/order-status.js';

test('a shipped order is published with its id and status', () => {
  assert.deepEqual(toStatusPayload({ id: 'A-1', state: 'shipped' }), { version: 1, id: 'A-1', status: 'shipped' });
});

test('every known state is published as its status', () => {
  for (const state of ['placed', 'shipped', 'delivered']) {
    assert.equal(toStatusPayload({ id: 'A-2', state }).status, state);
  }
});

test('an order without an id is refused', () => {
  assert.throws(() => toStatusPayload({ state: 'placed' }), TypeError);
});

test('an unknown state is refused', () => {
  assert.throws(() => toStatusPayload({ id: 'A-3', state: 'lost' }), RangeError);
});
