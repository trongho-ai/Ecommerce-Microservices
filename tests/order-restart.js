// Stage the durable crash boundary, then let an external coordinator kill/restart
// Order Service. This is not a live HTTP request paused at an injected fault flag.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { MongoClient } from 'mongodb';
import { createClient, request } from '../shared/grpc.js';
import { DEMO_ACCOUNTS } from '../scripts/fixtures.js';

const mode = process.argv[2];
const pool = new pg.Pool({ connectionString: process.env.ORDER_DATABASE_URL, connectionTimeoutMillis: 3000 });
const mongo = new MongoClient(process.env.PRODUCT_MONGO_URL, { serverSelectionTimeoutMS: 3000 });
const productClient = createClient('product', 'ProductService', process.env.PRODUCT_GRPC || 'product-service:50051');
const base = process.env.API_BASE_URL || 'http://localhost:3001';
let operationId;
function uuid(value) {
  assert.ok(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value), 'operationId must be a canonical UUID v4');
  return value.toLowerCase();
}
async function api(path, body, token, status = 200) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(35000) });
  const data = await response.json(); assert.equal(response.status, status, `${path}: ${JSON.stringify(data)}`); return data;
}
async function attempt() {
  const row = (await pool.query('SELECT * FROM order_attempts WHERE operation_id=$1', [operationId])).rows[0];
  assert.ok(row?.request?.fixture?.runId?.startsWith('restart_'), 'Attempt must be a fixture created by prepare mode');
  assert.equal(row.request.items.length, 1); return row;
}
async function stock(pid) {
  const row = await mongo.db('product').collection('products').findOne({ pid });
  assert.ok(row, 'Fixture Product must exist'); return row.quantity;
}
try {
  await mongo.connect();
  if (mode === 'prepare') {
    const runId = `restart_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const admin = await api('/api/auth/login', DEMO_ACCOUNTS.admin);
    const credentials = { username: runId, password: 'RestartDemo123!' };
    const buyer = await api('/api/auth/register', credentials, null, 201);
    await api('/api/auth/login', credentials);
    const initialStock = 14;
    const product = await api('/api/products', { pname: `${runId}_stock`, price: '12.50', quantity: initialStock }, admin.accessToken, 201);
    operationId = randomUUID();
    const items = [{ pid: product.pid, qty: 4 }];
    const snapshot = { items, fixture: { runId, initialStock, pid: product.pid } };
    await pool.query("INSERT INTO order_attempts(operation_id,uid,request,score,state,lease_until) VALUES($1,$2,$3,0,'PREPARED',now()+interval '120 seconds')", [operationId, buyer.uid, JSON.stringify(snapshot)]);
    const applied = await request(productClient, 'ApplyInventory', { operationId, items }, { uid: buyer.uid, role: 'SYSTEM' }, { timeout: 15000 });
    assert.equal(applied.state, 'APPLIED');
    const currentStock = await stock(product.pid); assert.equal(currentStock, initialStock - 4);
    console.log(JSON.stringify({ mode, status: 'PASS', operationId, uid: buyer.uid, pid: product.pid, initialStock, appliedQty: 4, stock: currentStock, state: 'PREPARED', boundary: 'durable attempt + applied inventory, before Order commit' }));
  } else if (mode === 'expire') {
    operationId = uuid(process.argv[3]);
    const row = await attempt(); assert.equal(row.state, 'PREPARED');
    const receipt = await mongo.db('product').collection('inventory_operations').findOne({ _id: operationId });
    assert.equal(receipt?.state, 'APPLIED');
    const pid = row.request.fixture.pid;
    const currentStock = await stock(pid);
    assert.equal(currentStock, row.request.fixture.initialStock - row.request.items[0].qty);
    const updated = await pool.query("UPDATE order_attempts SET lease_until=now()-interval '1 second' WHERE operation_id=$1 AND state='PREPARED'", [operationId]);
    assert.equal(updated.rowCount, 1);
    console.log(JSON.stringify({ mode, status: 'PASS', operationId, uid: row.uid, pid, initialStock: row.request.fixture.initialStock, stock: currentStock, state: 'PREPARED', leaseExpired: true }));
  } else if (mode === 'check') {
    operationId = uuid(process.argv[3]);
    const deadline = Date.now() + 45000;
    let row;
    do {
      row = await attempt(); if (row.state === 'ABORTED') break;
      await new Promise(resolve => setTimeout(resolve, 300));
    } while (Date.now() < deadline);
    assert.equal(row.state, 'ABORTED', 'Restarted Order recovery worker must finish compensation');
    const receipt = await mongo.db('product').collection('inventory_operations').findOne({ _id: operationId });
    assert.equal(receipt?.state, 'CANCELLED');
    const pid = row.request.fixture.pid;
    const currentStock = await stock(pid); assert.equal(currentStock, row.request.fixture.initialStock);
    const orderCount = Number((await pool.query('SELECT count(*) FROM orders WHERE operation_id=$1', [operationId])).rows[0].count);
    const outboxCount = Number((await pool.query("SELECT count(*) FROM outbox_events WHERE (payload->'payload'->>'uid')::integer=$1", [row.uid])).rows[0].count);
    assert.equal(orderCount, 0); assert.equal(outboxCount, 0);
    console.log(JSON.stringify({ mode, status: 'PASS', operationId, uid: row.uid, pid, initialStock: row.request.fixture.initialStock, stock: currentStock, state: row.state, receipt: receipt.state, orderCount, outboxCount, scope: 'staged durable boundary recovered after actual process restart' }));
  } else throw new Error('Usage: node tests/order-restart.js prepare | expire <UUID> | check <UUID>');
} catch (error) {
  if (mode === 'prepare' && operationId) await pool.query("UPDATE order_attempts SET lease_until=now()-interval '1 second' WHERE operation_id=$1 AND state='PREPARED'", [operationId]).catch(() => {});
  console.error(JSON.stringify({ mode, status: 'FAIL', operationId, error: error.message })); process.exitCode = 1;
} finally {
  productClient.close(); await mongo.close().catch(() => {}); await pool.end().catch(() => {});
}
