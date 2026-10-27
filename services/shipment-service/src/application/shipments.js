import { positiveId, requireActor, requireOwner } from '../../../../shared/errors.js';
import { validateStatus } from '../domain/shipment.js';

export class ShipmentApplication {
  constructor(repository) { this.repository = repository; }
  async get(input, actor) {
    requireActor(actor); positiveId(input.shipid, 'shipid');
    const shipment = await this.repository.get(input.shipid);
    requireOwner(actor, shipment.uid);
    return shipment;
  }
  async update(input, actor) {
    requireActor(actor, ['ADMIN', 'SHIPMENT_STAFF']); positiveId(input.shipid, 'shipid');
    return this.repository.update(input.shipid, validateStatus(input.status));
  }
  async byOrder(input, actor) {
    requireActor(actor); positiveId(input.oid, 'oid');
    const items = await this.repository.listByOrder(input.oid);
    if (!['ADMIN', 'SYSTEM'].includes(actor.role)) for (const item of items) requireOwner(actor, item.uid);
    return { items };
  }
}
