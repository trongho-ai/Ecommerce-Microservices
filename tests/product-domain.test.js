import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItems, operationId, productInput } from '../services/product-service/src/domain/product.js';

test('product input normalizes decimal money without floating-point calculation', () => {
  assert.deepEqual(productInput({ pname: '  Book  ', price: '12.30', quantity: 0 }), { pname: 'Book', price: '12.30', quantity: 0 });
  assert.throws(() => productInput({ pname: 'Book', price: '12.345', quantity: 1 }), { status: 400 });
  assert.throws(() => productInput({ pname: 'Book', price: '12.30', quantity: -1 }), { status: 400 });
});

test('partial Product update distinguishes quantity zero from an omitted field', () => {
  assert.deepEqual(productInput({ pid: 1, quantity: 0 }, { partial: true }), { quantity: 0 });
  assert.deepEqual(productInput({ pid: 1, price: '0' }, { partial: true }), { price: '0.00' });
  assert.throws(() => productInput({ pid: 1 }, { partial: true }), { status: 400 });
});

test('inventory items merge duplicate pid and sort into a stable idempotency identity', () => {
  assert.deepEqual(normalizeItems([{ pid: 2, qty: 1 }, { pid: 1, qty: 2 }, { pid: 2, qty: 3 }]), [{ pid: 1, qty: 2 }, { pid: 2, qty: 4 }]);
  assert.throws(() => normalizeItems([]), { status: 400 });
  assert.throws(() => normalizeItems([{ pid: 1, qty: 0 }]), { status: 400 });
  assert.throws(() => normalizeItems([{ pid: 1, qty: 1.5 }]), { status: 400 });
  assert.throws(() => normalizeItems([{ pid: 1, qty: 2147483647 }, { pid: 1, qty: 1 }]), { status: 400 });
});

test('inventory operation identifiers are bounded and reject ambiguous path characters', () => {
  assert.equal(operationId('90b737ac-b26e-4647-bc96-111111111111'), '90b737ac-b26e-4647-bc96-111111111111');
  assert.throws(() => operationId(''), { status: 400 });
  assert.throws(() => operationId('../x'), { status: 400 });
});
