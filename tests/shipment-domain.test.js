import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOrderCreated, validateStatus } from '../services/shipment-service/src/domain/shipment.js';

function event() { return { eventId: 'test-event', eventType: 'OrderCreated', eventVersion: 1, occurredAt: new Date().toISOString(), payload: { oid: 1, uid: 1, items: [{ pid: 1, qty: 2, unit_price: '25.00' }], subtotal: '50.00', discount: '5.00', total_amount: '45.00' } }; }
test('OrderCreated has required identity and valid money', () => {
  assert.equal(parseOrderCreated(JSON.stringify(event())).payload.oid, 1);
  const missingOid = event(); delete missingOid.payload.oid;
  assert.throws(() => parseOrderCreated(JSON.stringify(missingOid)));
  assert.throws(() => parseOrderCreated('not json'));
  const badQuantity = event(); badQuantity.payload.items[0].qty = -1;
  assert.throws(() => parseOrderCreated(JSON.stringify(badQuantity)));
  const inconsistent = event(); inconsistent.payload.total_amount = '46.00';
  assert.throws(() => parseOrderCreated(JSON.stringify(inconsistent)));
});
test('shipment accepts documented status set and rejects unrecognized values', () => {
  assert.equal(validateStatus('SHIPPING'), 'SHIPPING');
  assert.throws(() => validateStatus('PAID'));
});
