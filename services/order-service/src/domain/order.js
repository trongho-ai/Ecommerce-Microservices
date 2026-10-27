import { fail, positiveId } from '../../../../shared/errors.js';
import { toMinor, fromMinor } from '../../../../shared/money.js';

// Demo policy: the input documents do not define thresholds. Configure explicitly.
export const DEMO_POLICY = [{ minScore: 0, rate: 0 }, { minScore: 100, rate: 5 }, { minScore: 500, rate: 10 }];
export function parsePolicy(value = JSON.stringify(DEMO_POLICY)) {
  const policy = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(policy) || !policy.length) throw new Error('DISCOUNT_POLICY must be a non-empty array');
  const result = policy.map(row => ({ minScore: row.minScore, rate: row.rate })).sort((a, b) => a.minScore - b.minScore);
  for (let i = 0; i < result.length; i++) {
    const { minScore, rate } = result[i];
    if (!Number.isInteger(minScore) || minScore < 0 || minScore > 2147483647 || !Number.isInteger(rate) || rate < 0 || rate > 100 || (i && result[i - 1].minScore === minScore)) throw new Error('Invalid discount policy');
  }
  if (result[0].minScore !== 0) throw new Error('Discount policy must start at score 0');
  return Object.freeze(result.map(Object.freeze));
}
export function normalizeItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) fail(400, 'Order must contain 1 to 100 items');
  const quantities = new Map();
  for (const item of items) {
    positiveId(item.pid, 'pid');
    positiveId(item.qty, 'qty');
    const qty = (quantities.get(item.pid) || 0) + item.qty;
    positiveId(qty, 'combined qty');
    quantities.set(item.pid, qty);
  }
  return [...quantities].sort(([a], [b]) => a - b).map(([pid, qty]) => ({ pid, qty }));
}
export function calculateTotals(items, score, policy) {
  if (!Number.isInteger(score) || score < 0 || score > 2147483647) fail(400, 'Invalid membership score');
  let subtotal = 0;
  for (const item of items) {
    positiveId(item.pid, 'pid');
    positiveId(item.qty, 'qty');
    subtotal += toMinor(item.unit_price) * item.qty;
    if (!Number.isSafeInteger(subtotal) || subtotal > 9999999999) fail(400, 'Order amount exceeds DECIMAL(10,2)');
  }
  const rate = [...policy].reverse().find(row => score >= row.minScore).rate;
  // Rates are whole percentages. Integer arithmetic gives exact half-up rounding.
  const discount = Math.floor((subtotal * rate + 50) / 100);
  return { subtotal: fromMinor(subtotal), discount: fromMinor(discount), total_amount: fromMinor(subtotal - discount), discount_rate: rate };
}
