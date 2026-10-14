import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toStatusPayload } from '../src/order-status.js';

test('a shipped order is published with its id and status', () => {
  assert.deepEqual(toStatusPayload({ id: 'A-1', state: 'shipped' }), { version: 2, id: 'A-1', status: 'shipped' });
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

test('a delayed order is published with its eta at contract version 2', () => {
  assert.deepEqual(toStatusPayload({ id: 'A-7', state: 'delayed', eta: '2026-11-03' }), { version: 2, id: 'A-7', status: 'delayed', eta: '2026-11-03' });
});

test('every other payload carries version 2 and no eta', () => {
  for (const state of ['placed', 'shipped', 'delivered']) {
    const payload = toStatusPayload({ id: 'A-4', state, eta: '2026-11-03' });
    assert.equal(payload.version, 2);
    assert.equal(Object.hasOwn(payload, 'eta'), false);
  }
});

test('a delayed order without a valid eta is refused, naming the order', () => {
  for (const eta of [undefined, '', 'next week', '2026-13-45', '2026-11-3']) {
    assert.throws(
      () => toStatusPayload({ id: 'A-8', state: 'delayed', eta }),
      (err) => err instanceof RangeError && err.message.includes('A-8'),
    );
  }
});
