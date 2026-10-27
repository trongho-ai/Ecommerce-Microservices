import { fail, positiveId } from '../../../../shared/errors.js';
import { fromMinor, toMinor } from '../../../../shared/money.js';

const MAX_INT = 2147483647;

export function productName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) {
    fail(400, 'pname must contain 1 to 100 characters');
  }
  return value.trim();
}

export function stockQuantity(value) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_INT) {
    fail(400, 'quantity must be a non-negative 32-bit integer');
  }
  return value;
}

export function productInput(input, { partial = false } = {}) {
  const result = {};
  if (!partial || Object.hasOwn(input, 'pname')) result.pname = productName(input.pname);
  if (!partial || Object.hasOwn(input, 'price')) result.price = fromMinor(toMinor(input.price));
  if (!partial || Object.hasOwn(input, 'quantity')) result.quantity = stockQuantity(input.quantity);
  if (partial && !Object.keys(result).length) fail(400, 'At least one product field is required');
  return result;
}

// Sorting and merging duplicate pid makes the idempotency fingerprint canonical.
export function normalizeItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    fail(400, 'Order must contain 1 to 100 items');
  }
  const quantities = new Map();
  for (const item of items) {
    const pid = positiveId(item.pid, 'pid');
    positiveId(item.qty, 'qty');
    const qty = (quantities.get(pid) || 0) + item.qty;
    if (qty > MAX_INT) fail(400, 'Combined qty is out of range');
    quantities.set(pid, qty);
  }
  return [...quantities.entries()].sort(([left], [right]) => left - right).map(([pid, qty]) => ({ pid, qty }));
}

export function operationId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    fail(400, 'operationId must contain 1 to 128 safe identifier characters');
  }
  return value;
}
