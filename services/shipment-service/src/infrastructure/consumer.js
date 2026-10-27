import { ORDER_TOPIC } from '../../../../shared/kafka.js';
import { parseOrderCreated } from '../domain/shipment.js';

export class ShipmentConsumer {
  constructor(repository, kafka) {
    this.repository = repository;
    this.consumer = kafka.consumer({ groupId: process.env.SHIPMENT_GROUP || 'shipment-service-v1', allowAutoTopicCreation: false, retry: { retries: 5 } });
    this.ready = false;
    this.started = false;
    this.starting = false;
    this.stopped = false;
    this.consumer.on(this.consumer.events.GROUP_JOIN, () => { this.ready = true; });
    this.consumer.on(this.consumer.events.DISCONNECT, () => { this.ready = false; });
    this.consumer.on(this.consumer.events.CRASH, event => {
      this.ready = false;
      if (!event.payload.restart) this.started = false;
    });
  }
  async start() {
    if (this.starting || this.started || this.stopped) return;
    this.starting = true;
    try {
      await this.consumer.connect();
      await this.consumer.subscribe({ topic: ORDER_TOPIC, fromBeginning: true });
      await this.consumer.run({ eachMessage: async ({ message }) => {
        const raw = message.value?.toString('utf8') || '';
        let event;
        try { event = parseOrderCreated(raw); }
        catch (error) { await this.repository.reject(raw, error.message); return; }
        const shipment = await this.repository.receive(event, raw);
        console.log(JSON.stringify({ service: 'shipment', action: 'event-consumed', eventId: event.eventId, oid: shipment.oid, shipid: shipment.shipid }));
      } });
      this.started = true;
    } catch (error) {
      this.ready = false; this.started = false;
      console.error(JSON.stringify({ service: 'shipment', action: 'consumer-retry', error: error.message }));
      await this.consumer.disconnect().catch(() => {});
    } finally { this.starting = false; }
  }
  async close() { this.stopped = true; this.ready = false; await this.consumer.disconnect(); }
}
