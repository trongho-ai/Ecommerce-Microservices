import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fail } from '../../../../shared/errors.js';

export class OrderRepository {
  constructor(pool) { this.pool = pool; }
  async migrate() { await this.pool.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8')); }
  async health() { await this.pool.query('SELECT 1'); }
  async prepare(operationId, uid, items, score) {
    await this.pool.query("INSERT INTO order_attempts(operation_id,uid,request,score,state,lease_until) VALUES($1,$2,$3,$4,'PREPARED',now()+interval '30 seconds')", [operationId, uid, JSON.stringify({ items }), score]);
  }
  async findByOperation(operationId) {
    const { rows } = await this.pool.query('SELECT oid FROM orders WHERE operation_id=$1', [operationId]);
    return rows[0] ? this.get(rows[0].oid) : null;
  }
  async get(oid) {
    const { rows } = await this.pool.query('SELECT oid,uid,discount,subtotal,total_amount,score,discount_rate,event_id FROM orders WHERE oid=$1', [oid]);
    if (!rows.length) fail(404, 'Order not found');
    const details = await this.pool.query('SELECT pid,qty,unit_price FROM order_details WHERE oid=$1 ORDER BY pid', [oid]);
    const { event_id, ...row } = rows[0];
    return { ...row, items: details.rows, shipments: [], eventId: event_id };
  }
  async list(uid) {
    const { rows } = await this.pool.query('SELECT oid FROM orders WHERE uid=$1 ORDER BY oid DESC', [uid]);
    return Promise.all(rows.map(row => this.get(row.oid)));
  }
  async commit(operationId, items, totals) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const attempt = (await db.query('SELECT * FROM order_attempts WHERE operation_id=$1 FOR UPDATE', [operationId])).rows[0];
      if (!attempt) fail(409, 'Order attempt not found');
      if (attempt.state === 'COMMITTED') {
        await db.query('COMMIT');
        return await this.findByOperation(operationId);
      }
      if (attempt.state !== 'PREPARED') fail(409, 'Order attempt was cancelled', 'ORDER_CANCELLED');
      const eventId = randomUUID();
      const { rows } = await db.query('INSERT INTO orders(operation_id,uid,discount,subtotal,total_amount,score,discount_rate,event_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING oid', [operationId, attempt.uid, totals.discount, totals.subtotal, totals.total_amount, attempt.score, totals.discount_rate, eventId]);
      const oid = rows[0].oid;
      for (const item of items) await db.query('INSERT INTO order_details(oid,pid,qty,unit_price) VALUES($1,$2,$3,$4)', [oid, item.pid, item.qty, item.unit_price]);
      const event = { eventId, eventType: 'OrderCreated', eventVersion: 1, occurredAt: new Date().toISOString(), payload: { oid, uid: attempt.uid, items, discount: totals.discount, subtotal: totals.subtotal, total_amount: totals.total_amount } };
      await db.query("INSERT INTO outbox_events(event_id,aggregate_id,event_type,payload) VALUES($1,$2,'OrderCreated',$3)", [eventId, oid, JSON.stringify(event)]);
      await db.query("UPDATE order_attempts SET state='COMMITTED',updated_at=now() WHERE operation_id=$1", [operationId]);
      await db.query('COMMIT');
      return { oid, uid: attempt.uid, ...totals, score: attempt.score, items, shipments: [], eventId };
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { db.release(); }
  }
  // This row lock is the boundary between committing an Order and compensating it.
  async claimAbort(operationId) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const row = (await db.query('SELECT * FROM order_attempts WHERE operation_id=$1 FOR UPDATE', [operationId])).rows[0];
      if (!row) fail(404, 'Order attempt not found');
      if (row.state === 'COMMITTED' || row.state === 'ABORTED') { await db.query('COMMIT'); return row.state; }
      await db.query("UPDATE order_attempts SET state='ABORTING',lease_until=now()+interval '30 seconds',updated_at=now() WHERE operation_id=$1", [operationId]);
      await db.query('COMMIT');
      return 'ABORTING';
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
    finally { db.release(); }
  }
  async finishAbort(operationId) {
    await this.pool.query("UPDATE order_attempts SET state='ABORTED',updated_at=now() WHERE operation_id=$1 AND state='ABORTING'", [operationId]);
  }
  async expiredAttempts() {
    return (await this.pool.query("SELECT operation_id,uid FROM order_attempts WHERE state IN ('PREPARED','ABORTING') AND lease_until<now() ORDER BY created_at LIMIT 20")).rows;
  }
  async pendingEvents() { return (await this.pool.query("SELECT event_id,aggregate_id,payload FROM outbox_events WHERE status='PENDING' ORDER BY created_at LIMIT 20")).rows; }
  async sent(eventId) { await this.pool.query("UPDATE outbox_events SET status='SENT',sent_at=now(),attempts=attempts+1,last_error=NULL WHERE event_id=$1", [eventId]); }
  async failed(eventId, error) { await this.pool.query('UPDATE outbox_events SET attempts=attempts+1,last_error=$2 WHERE event_id=$1', [eventId, String(error.message).slice(0, 500)]); }
}
