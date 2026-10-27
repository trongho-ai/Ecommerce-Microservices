import { randomUUID } from 'node:crypto';
import { AppError, fail, positiveId, requireActor, requireOwner } from '../../../../shared/errors.js';
import { normalizeItems, calculateTotals } from '../domain/order.js';

export class OrderApplication {
  constructor(repository, dependencies, policy) { this.repository = repository; this.dependencies = dependencies; this.policy = policy; }
  async create(input, actor) {
    requireActor(actor, ['CUSTOMER', 'ADMIN']);
    const items = normalizeItems(input.items);
    const [, membership] = await Promise.all([this.dependencies.customer('GetCustomer', { uid: actor.uid }, actor), this.dependencies.customer('GetMembership', { uid: actor.uid }, actor)]);
    const products = await Promise.all(items.map(item => this.dependencies.product('GetProduct', { pid: item.pid }, actor)));
    // Validate the entire basket and amount before any inventory side effect.
    calculateTotals(items.map((item, index) => ({ ...item, unit_price: products[index].price })), membership.score, this.policy);
    const operationId = randomUUID();
    await this.repository.prepare(operationId, actor.uid, items, membership.score);
    try {
      const operation = await this.dependencies.product('ApplyInventory', { operationId, items }, { uid: actor.uid, role: 'SYSTEM' }, { timeout: 10000 });
      if (operation.state !== 'APPLIED') fail(409, 'Inventory operation is not applied');
      const totals = calculateTotals(operation.items, membership.score, this.policy);
      return await this.repository.commit(operationId, operation.items, totals);
    } catch (error) {
      // A COMMIT acknowledgement can be lost. Query/lock durable state before undoing stock.
      try {
        const committed = await this.abort(operationId, actor.uid);
        if (committed) return committed;
      } catch (compensationError) {
        console.error(JSON.stringify({ service: 'order', operationId, recoveryPending: true, error: compensationError.message }));
        throw new AppError(503, 'Order completion is pending recovery; check your order list before retrying', 'ORDER_RECOVERY_PENDING');
      }
      throw error;
    }
  }
  async abort(operationId, uid) {
    const state = await this.repository.claimAbort(operationId);
    if (state === 'COMMITTED') return this.repository.findByOperation(operationId);
    if (state === 'ABORTED') return null;
    const cancelled = await this.dependencies.product('CancelInventory', { operationId }, { uid, role: 'SYSTEM' }, { timeout: 10000 });
    if (cancelled.state !== 'CANCELLED') fail(503, 'Inventory compensation is not confirmed');
    await this.repository.finishAbort(operationId);
    return null;
  }
  async recover() {
    for (const row of await this.repository.expiredAttempts()) {
      try { await this.abort(row.operation_id, row.uid); }
      catch (error) { console.error(JSON.stringify({ service: 'order', operationId: row.operation_id, recoveryPending: true, error: error.message })); }
    }
  }
  async get(input, actor) {
    requireActor(actor);
    positiveId(input.oid, 'oid');
    const order = await this.repository.get(input.oid);
    requireOwner(actor, order.uid);
    try { order.shipments = (await this.dependencies.shipment('GetShipmentsByOrder', { oid: order.oid }, actor, { timeout: 2000 })).items; }
    catch (error) { if (![503, 504].includes(error.status)) throw error; }
    return order;
  }
  async list(_input, actor) { requireActor(actor); return { items: await this.repository.list(actor.uid) }; }
}
