import { ORDER_TOPIC } from '../../../../shared/kafka.js';

export class OutboxPublisher {
  constructor(repository, kafka) {
    this.repository = repository;
    this.producer = kafka.producer({ allowAutoTopicCreation: false, idempotent: true, maxInFlightRequests: 1 });
    this.connected = false;
    this.busy = false;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const events = await this.repository.pendingEvents();
      if (!events.length) return;
      for (const event of events) {
        try {
          if (!this.connected) { await this.producer.connect(); this.connected = true; }
          await this.producer.send({ topic: ORDER_TOPIC, acks: -1, messages: [{ key: String(event.aggregate_id), value: JSON.stringify(event.payload) }] });
          await this.repository.sent(event.event_id);
          console.log(JSON.stringify({ service: 'order', action: 'outbox-sent', eventId: event.event_id, oid: event.aggregate_id }));
        } catch (error) {
          await this.repository.failed(event.event_id, error);
          this.connected = false;
          await this.producer.disconnect().catch(() => {});
          break;
        }
      }
    } catch (error) { console.error(JSON.stringify({ service: 'order', action: 'outbox-retry', error: error.message })); }
    finally { this.busy = false; }
  }
  async close() { await this.producer.disconnect().catch(() => {}); }
}
