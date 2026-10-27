// External coordinator stops Kafka before `create`, starts it before `check <oid>`.
// This file never stops or deletes infrastructure itself.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { MongoClient } from 'mongodb';
import { DEMO_ACCOUNTS } from '../scripts/fixtures.js';
import { kafkaClient, ORDER_TOPIC } from '../shared/kafka.js';

const mode = process.argv[2];
const base = process.env.API_BASE_URL || 'http://localhost:3001';
const pool = new pg.Pool({ connectionString: process.env.ORDER_DATABASE_URL, connectionTimeoutMillis: 3000 });
const productMongo = new MongoClient(process.env.PRODUCT_MONGO_URL, { serverSelectionTimeoutMS: 3000 });
const shipmentMongo = new MongoClient(process.env.SHIPMENT_MONGO_URL, { serverSelectionTimeoutMS: 3000 });
let consumer;
async function api(path, body, token, expected = 200) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(35000) });
  const data = await response.json();
  assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`);
  return data;
}
async function until(fn, description, timeout = 45000) {
  const deadline = Date.now() + timeout;
  do { const result = await fn(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 400)); } while (Date.now() < deadline);
  throw new Error(`Timeout: ${description}`);
}
try {
  await productMongo.connect();
  if (mode === 'create') {
    const name = `outage_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const admin = await api('/api/auth/login', DEMO_ACCOUNTS.admin);
    const credentials = { username: name, password: 'OutageDemo123!' };
    const user = await api('/api/auth/register', credentials, null, 201);
    const login = await api('/api/auth/login', credentials);
    const product = await api('/api/products', { pname: `${name}_stock`, price: '20.00', quantity: 8 }, admin.accessToken, 201);
    const order = await api('/api/orders', { items: [{ pid: product.pid, qty: 2 }] }, login.accessToken, 201);
    const row = (await pool.query('SELECT event_id,status FROM outbox_events WHERE aggregate_id=$1', [order.oid])).rows[0];
    assert.ok(row); assert.equal(row.status, 'PENDING');
    assert.equal((await productMongo.db('product').collection('products').findOne({ pid: product.pid })).quantity, 6);
    console.log(JSON.stringify({ mode, status: 'PASS', oid: order.oid, uid: user.uid, pid: product.pid, eventId: row.event_id, outbox: row.status, stock: 6 }));
  } else if (mode === 'check') {
    const oid = Number(process.argv[3]);
    assert.ok(Number.isInteger(oid) && oid > 0, 'check requires a positive oid argument from create output');
    const event = await until(async () => {
      const row = (await pool.query('SELECT event_id,status,payload,attempts FROM outbox_events WHERE aggregate_id=$1', [oid])).rows[0];
      return row?.status === 'SENT' ? row : false;
    }, 'pending Outbox retry to SENT after broker restart');
    await shipmentMongo.connect();
    const shipment = await until(() => shipmentMongo.db('shipment').collection('shipments').findOne({ sourceEventId: event.event_id }), 'Shipment from recovered event');
    assert.equal(shipment.oid, oid);
    assert.equal(await shipmentMongo.db('shipment').collection('shipments').countDocuments({ sourceEventId: event.event_id }), 1);
    let observed;
    const groupId = `outage-proof-${randomUUID()}`;
    consumer = kafkaClient('outage-proof').consumer({ groupId });
    await consumer.connect(); await consumer.subscribe({ topic: ORDER_TOPIC, fromBeginning: true });
    await consumer.run({ eachMessage: async ({ message }) => {
      let messageEvent;
      try { messageEvent = JSON.parse(message.value.toString()); } catch { return; }
      if (messageEvent.eventId === event.event_id) observed = messageEvent;
    } });
    await until(() => observed, 'independent Kafka consumer observes exact recovered event');
    assert.deepEqual(observed, event.payload);
    console.log(JSON.stringify({ mode, status: 'PASS', oid, eventId: event.event_id, outbox: event.status, publishAttempts: event.attempts, shipid: shipment.shipid, shipmentCount: 1, kafkaObserved: true, proofGroup: groupId }));
  } else throw new Error('Usage: node tests/kafka-outage.js create | check <oid>');
} catch (error) {
  console.error(JSON.stringify({ mode, status: 'FAIL', error: error.message })); process.exitCode = 1;
} finally {
  await consumer?.disconnect().catch(() => {});
  await productMongo.close().catch(() => {}); await shipmentMongo.close().catch(() => {}); await pool.end().catch(() => {});
}
