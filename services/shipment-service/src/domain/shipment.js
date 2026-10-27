import { createHash } from 'node:crypto';
import { fail, positiveId } from '../../../../shared/errors.js';
import { toMinor } from '../../../../shared/money.js';

export const SHIPMENT_STATUSES = Object.freeze(['PENDING', 'SHIPPING', 'DELIVERED', 'CANCELLED']);
export function validateStatus(status) { if (!SHIPMENT_STATUSES.includes(status)) fail(400, 'Invalid shipment status'); return status; }
export function parseOrderCreated(raw) {
  let event;
  try { event = JSON.parse(raw); } catch { fail(400, 'Event must be JSON'); }
  if (!event || event.eventType !== 'OrderCreated' || event.eventVersion !== 1 || typeof event.eventId !== 'string' || event.eventId.length < 1 || event.eventId.length > 100 || !Number.isFinite(Date.parse(event.occurredAt))) fail(400, 'Invalid OrderCreated envelope');
  const payload = event.payload;
  if (!payload) fail(400, 'OrderCreated payload is required');
  positiveId(payload.oid, 'oid'); positiveId(payload.uid, 'uid');
  if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > 100) fail(400, 'OrderCreated items are required');
  let sum = 0;
  const pids = new Set();
  for (const item of payload.items) {
    positiveId(item.pid, 'pid'); positiveId(item.qty, 'qty');
    if (pids.has(item.pid)) fail(400, 'OrderCreated items contain a repeated pid');
    pids.add(item.pid);
    sum += toMinor(item.unit_price) * item.qty;
    if (!Number.isSafeInteger(sum) || sum > 9999999999) fail(400, 'OrderCreated amount is out of range');
  }
  const discount = toMinor(payload.discount);
  const subtotal = toMinor(payload.subtotal);
  const total = toMinor(payload.total_amount);
  if (subtotal !== sum || discount > subtotal || total !== subtotal - discount) fail(400, 'OrderCreated totals are inconsistent');
  return event;
}
export function eventHash(raw) { return createHash('sha256').update(raw).digest('hex'); }
