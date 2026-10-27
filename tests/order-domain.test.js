import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_POLICY, parsePolicy, normalizeItems, calculateTotals } from '../services/order-service/src/domain/order.js';

const policy = parsePolicy(DEMO_POLICY);
test('demo policy changes only at documented score boundaries', () => {
  const items = [{ pid: 1, qty: 2, unit_price: '100.00' }];
  for (const [score, rate, discount] of [[0,0,'0.00'],[99,0,'0.00'],[100,5,'10.00'],[499,5,'10.00'],[500,10,'20.00']]) {
    const result = calculateTotals(items, score, policy);
    assert.equal(result.discount_rate, rate); assert.equal(result.discount, discount);
  }
});
test('discount uses exact half-up money arithmetic', () => {
  assert.deepEqual(calculateTotals([{ pid: 1, qty: 1, unit_price: '0.10' }], 100, policy), { subtotal: '0.10', discount: '0.01', total_amount: '0.09', discount_rate: 5 });
});
test('repeated products merge before conditional inventory update', () => {
  assert.deepEqual(normalizeItems([{ pid: 2, qty: 1 }, { pid: 1, qty: 2 }, { pid: 2, qty: 3 }]), [{ pid: 1, qty: 2 }, { pid: 2, qty: 4 }]);
  assert.throws(() => normalizeItems([])); assert.throws(() => normalizeItems([{ pid: 1, qty: 0 }]));
});
test('money overflow and invalid policy are rejected before inventory changes', () => {
  assert.throws(() => calculateTotals([{ pid: 1, qty: 2, unit_price: '99999999.99' }], 0, policy));
  assert.throws(() => parsePolicy([{ minScore: 100, rate: 5 }]));
  assert.throws(() => parsePolicy([{ minScore: 0, rate: 101 }]));
  assert.throws(() => parsePolicy([{ minScore: 0, rate: 0 }, { minScore: 0, rate: 5 }]));
});
