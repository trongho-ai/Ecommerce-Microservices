import { fail, positiveId } from '../../../../shared/errors.js';
import { eventHash } from '../domain/shipment.js';

export class ShipmentRepository {
  constructor(database) { this.database = database; this.shipments = database.collection('shipments'); this.rejected = database.collection('rejected_events'); }
  async migrate() {
    await this.shipments.createIndex({ shipid: 1 }, { unique: true });
    await this.shipments.createIndex({ sourceEventId: 1 }, { unique: true });
    await this.shipments.createIndex({ oid: 1, uid: 1 });
  }
  async health() { await this.database.command({ ping: 1 }); }
  serialize(document) {
    if (!document) fail(404, 'Shipment not found');
    const { shipid, oid, uid, status, sourceEventId } = document;
    return { shipid, oid, uid, status, sourceEventId };
  }
  async get(shipid) { return this.serialize(await this.shipments.findOne({ shipid })); }
  async listByOrder(oid) { return (await this.shipments.find({ oid }).sort({ shipid: 1 }).toArray()).map(row => this.serialize(row)); }
  async update(shipid, status) {
    return this.serialize(await this.shipments.findOneAndUpdate({ shipid }, { $set: { status, updatedAt: new Date() } }, { returnDocument: 'after', includeResultMetadata: false }));
  }
  async receive(event, raw) {
    const fingerprint = eventHash(raw);
    const existing = await this.shipments.findOne({ sourceEventId: event.eventId });
    if (existing) {
      if (existing.sourceHash !== fingerprint) await this.reject(raw, 'Event ID reused with a different payload');
      return this.serialize(existing);
    }
    const counter = await this.database.collection('counters').findOneAndUpdate({ _id: 'shipid' }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after', includeResultMetadata: false });
    positiveId(counter.value, 'shipid');
    const document = { shipid: counter.value, oid: event.payload.oid, uid: event.payload.uid, status: 'PENDING', sourceEventId: event.eventId, sourceHash: fingerprint, createdAt: new Date(), updatedAt: new Date() };
    try { await this.shipments.insertOne(document); }
    catch (error) {
      if (error.code !== 11000) throw error;
      const duplicate = await this.shipments.findOne({ sourceEventId: event.eventId });
      if (!duplicate) throw error;
      if (duplicate.sourceHash !== fingerprint) await this.reject(raw, 'Event ID reused with a different payload');
      return this.serialize(duplicate);
    }
    return this.serialize(document);
  }
  async reject(raw, reason) {
    const id = eventHash(raw);
    await this.rejected.updateOne({ _id: id }, { $setOnInsert: { reason, raw, rejectedAt: new Date() } }, { upsert: true });
    console.error(JSON.stringify({ service: 'shipment', action: 'event-rejected', fingerprint: id, reason }));
  }
}
