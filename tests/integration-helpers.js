import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { MongoClient } from 'mongodb';
import { Kafka, logLevel } from 'kafkajs';

export const TOPIC = process.env.ORDER_TOPIC || 'order-created';
export const SYSTEM = { uid: 1, role: 'SYSTEM' };
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function poll(read, predicate, { timeout = 30000, interval = 250, description = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await read();
    if (predicate(lastValue)) return lastValue;
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export async function http(method, path, { token, body, status = 200 } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${process.env.API_BASE_URL || 'http://localhost:3001'}${path}`, {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(35000),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  assert.equal(response.status, status, `${method} ${path}: expected HTTP ${status}, received ${response.status}: ${JSON.stringify(data)}`);
  return data;
}

export class EvidenceResources {
  constructor() {
    this.pools = new Map();
    this.mongoClients = new Map();
    this.messages = new Map();
    this.observerError = null;
  }

  pg(owner) {
    if (!this.pools.has(owner)) {
      const url = process.env[`${owner.toUpperCase()}_DATABASE_URL`];
      if (!url) throw new Error(`${owner.toUpperCase()}_DATABASE_URL is required for real database evidence`);
      this.pools.set(owner, new Pool({ connectionString: url, connectionTimeoutMillis: 5000 }));
    }
    return this.pools.get(owner);
  }

  async mongo(owner) {
    if (!this.mongoClients.has(owner)) {
      const url = process.env[`${owner.toUpperCase()}_MONGO_URL`];
      if (!url) throw new Error(`${owner.toUpperCase()}_MONGO_URL is required for real MongoDB evidence`);
      const client = new MongoClient(url, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      this.mongoClients.set(owner, client);
    }
    return this.mongoClients.get(owner).db(process.env[`${owner.toUpperCase()}_MONGO_DATABASE`] || owner);
  }

  kafka() {
    if (!this.kafkaInstance) this.kafkaInstance = new Kafka({
      clientId: `ecommerce-evidence-${randomUUID().slice(0, 8)}`,
      brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(','),
      logLevel: logLevel.ERROR,
      connectionTimeout: 5000,
      requestTimeout: 10000,
      retry: { retries: 3 },
    });
    return this.kafkaInstance;
  }

  async producer() {
    if (!this.kafkaProducer) {
      this.kafkaProducer = this.kafka().producer({ allowAutoTopicCreation: false });
      await this.kafkaProducer.connect();
    }
    return this.kafkaProducer;
  }

  async admin() {
    if (!this.kafkaAdmin) {
      this.kafkaAdmin = this.kafka().admin();
      await this.kafkaAdmin.connect();
    }
    return this.kafkaAdmin;
  }

  async observeKafka() {
    if (this.consumer) return;
    this.consumer = this.kafka().consumer({
      groupId: `ecommerce-evidence-${randomUUID()}`,
      allowAutoTopicCreation: false,
      sessionTimeout: 15000,
      maxWaitTimeInMs: 500,
    });
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: TOPIC, fromBeginning: true });
    let joined = false;
    this.consumer.on(this.consumer.events.GROUP_JOIN, () => { joined = true; });
    this.consumer.on(this.consumer.events.CRASH, event => { this.observerError = event.payload.error; });
    await this.consumer.run({ eachMessage: async ({ topic, partition, message }) => {
      const raw = message.value?.toString('utf8') || '';
      try {
        const event = JSON.parse(raw);
        if (event.eventId) this.messages.set(event.eventId, { event, raw, topic, partition, offset: message.offset });
      } catch { /* malformed messages are evidence for Shipment rejection, not observer failure */ }
    } });
    await poll(() => joined, Boolean, { description: 'Kafka evidence consumer to join its independent group' });
  }

  async event(eventId, oid) {
    await this.observeKafka();
    const message = await poll(() => {
      if (this.observerError) throw this.observerError;
      return this.messages.get(eventId);
    }, Boolean, { description: `Kafka event ${eventId}` });
    assert.equal(message.event.eventType, 'OrderCreated');
    assert.equal(message.event.eventVersion, 1);
    assert.equal(message.event.payload.oid, oid);
    return message;
  }

  async publish(raw, key = 'integration') {
    const producer = await this.producer();
    return producer.send({ topic: TOPIC, acks: -1, messages: [{ key, value: raw }] });
  }

  async waitShipmentCaughtUp() {
    const admin = await this.admin();
    const target = await admin.fetchTopicOffsets(TOPIC);
    const groupId = process.env.SHIPMENT_GROUP || 'shipment-service-v1';
    await poll(async () => {
      const offsets = await admin.fetchOffsets({ groupId, topics: [TOPIC] });
      const committed = offsets.find(topic => topic.topic === TOPIC)?.partitions || [];
      return target.every(partition => {
        const actual = committed.find(value => value.partition === partition.partition);
        return actual && BigInt(actual.offset) >= BigInt(partition.offset);
      });
    }, Boolean, { description: 'Shipment consumer to commit offsets through duplicate events' });
  }

  async close() {
    const tasks = [
      ...[...this.pools.values()].map(pool => pool.end()),
      ...[...this.mongoClients.values()].map(client => client.close()),
      this.consumer?.disconnect(), this.kafkaProducer?.disconnect(), this.kafkaAdmin?.disconnect(),
    ].filter(Boolean);
    await Promise.allSettled(tasks);
  }
}

export function independentMoney(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  assert.ok(match, `Invalid decimal evidence: ${value}`);
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
}

export function independentDiscount(subtotalMinor, score) {
  const configured = process.env.DISCOUNT_POLICY;
  assert.ok(configured, 'DISCOUNT_POLICY must be passed to the evidence runner; expected policy must be explicit');
  const policy = JSON.parse(configured);
  assert.ok(Array.isArray(policy) && policy.length > 0, 'DISCOUNT_POLICY must be a non-empty array');
  const eligible = policy.filter(row => score >= row.minScore).sort((left, right) => right.minScore - left.minScore);
  assert.ok(eligible.length > 0, 'Policy must cover the test membership score');
  const rate = eligible[0].rate;
  assert.ok(Number.isInteger(rate) && rate >= 0 && rate <= 100);
  // Positive monetary amounts: integer arithmetic, round half up to one minor unit.
  return { rate, discount: Math.floor((subtotalMinor * rate + 50) / 100) };
}
