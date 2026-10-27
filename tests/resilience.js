// Run inside Compose test-runner: node tests/resilience.js.
// These checks use real HTTP, gRPC, PostgreSQL and MongoDB. All fixtures are new;
// no existing products, orders or volumes are reset.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { MongoClient } from 'mongodb';
import { createClient, request } from '../shared/grpc.js';
import { DEMO_ACCOUNTS } from '../scripts/fixtures.js';
import { OrderRepository } from '../services/order-service/src/infrastructure/repository.js';
import { calculateTotals, parsePolicy } from '../services/order-service/src/domain/order.js';

const apiBase = process.env.API_BASE_URL || 'http://localhost:3001';
const runId = `res_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const pool = new pg.Pool({ connectionString: process.env.ORDER_DATABASE_URL, connectionTimeoutMillis: 3000, query_timeout: 10000 });
const mongo = new MongoClient(process.env.PRODUCT_MONGO_URL, { serverSelectionTimeoutMS: 3000 });
const productClient = createClient('product', 'ProductService', process.env.PRODUCT_GRPC || 'product-service:50051');
const system = { uid: 1, role: 'SYSTEM' };
const results = [];
let adminToken;

async function api(method, path, body, token, expected) {
  const response = await fetch(`${apiBase}${path}`, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(35000),
  });
  const data = await response.json();
  if (expected !== undefined) assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(data)}`);
  return { status: response.status, data };
}
async function newBuyer(suffix) {
  const credentials = { username: `${runId}_${suffix}`, password: 'ResilienceDemo123!' };
  const registered = await api('POST', '/api/auth/register', credentials, null, 201);
  const login = await api('POST', '/api/auth/login', credentials, null, 200);
  return { uid: registered.data.uid, token: login.data.accessToken };
}
async function newProduct(suffix, quantity, price = '10.00') {
  return (await api('POST', '/api/products', { pname: `${runId}_${suffix}`, price, quantity }, adminToken, 201)).data;
}
async function quantity(pid) {
  const product = await mongo.db('product').collection('products').findOne({ pid });
  assert.ok(product, `Product ${pid} must exist in real MongoDB`);
  return product.quantity;
}
async function inventory(method, body) { return request(productClient, method, body, system, { timeout: 15000 }); }
async function eventually(check, description, timeout = 35000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 300));
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}${last ? ` (${last.message})` : ''}`);
}
async function check(name, fn) {
  const evidence = await fn();
  results.push({ name, status: 'PASS', evidence });
  console.log(JSON.stringify(results.at(-1)));
}

try {
  await mongo.connect();
  const login = await api('POST', '/api/auth/login', DEMO_ACCOUNTS.admin, null, 200);
  adminToken = login.data.accessToken;

  await check('Inventory retries/mismatch/cancel are idempotent in MongoDB', async () => {
    const product = await newProduct('idempotent', 10);
    const operationId = randomUUID();
    const body = { operationId, items: [{ pid: product.pid, qty: 3 }] };
    const first = await inventory('ApplyInventory', body);
    assert.equal(first.state, 'APPLIED');
    assert.deepEqual(await inventory('ApplyInventory', body), first);
    assert.equal(await quantity(product.pid), 7);
    await assert.rejects(() => inventory('ApplyInventory', { operationId, items: [{ pid: product.pid, qty: 4 }] }), error => error.status === 409);
    assert.equal(await quantity(product.pid), 7);
    await inventory('CancelInventory', { operationId });
    await inventory('CancelInventory', { operationId });
    assert.equal(await quantity(product.pid), 10);
    const receipt = await mongo.db('product').collection('inventory_operations').findOne({ _id: operationId });
    assert.equal(receipt.state, 'CANCELLED');
    return { pid: product.pid, operationId, stock: 10, receipt: receipt.state };
  });

  await check('Cancel tombstone prevents an Apply arriving later', async () => {
    const product = await newProduct('late_apply', 8);
    const operationId = randomUUID();
    await inventory('CancelInventory', { operationId });
    await assert.rejects(() => inventory('ApplyInventory', { operationId, items: [{ pid: product.pid, qty: 2 }] }), error => error.status === 409);
    assert.equal(await quantity(product.pid), 8);
    return { pid: product.pid, operationId, stock: 8 };
  });

  await check('A multi-product inventory failure rolls back every decrement', async () => {
    const first = await newProduct('basket_a', 10);
    const second = await newProduct('basket_b', 1);
    const operationId = randomUUID();
    await assert.rejects(() => inventory('ApplyInventory', { operationId, items: [{ pid: first.pid, qty: 2 }, { pid: second.pid, qty: 2 }] }), error => error.status === 409);
    assert.equal(await quantity(first.pid), 10);
    assert.equal(await quantity(second.pid), 1);
    assert.equal(await mongo.db('product').collection('inventory_operations').countDocuments({ _id: operationId }), 0);
    return { pids: [first.pid, second.pid], stocks: [10, 1], appliedReceiptCount: 0 };
  });

  await check('Two real concurrent Orders cannot oversell stock', async () => {
    const buyer = await newBuyer('race');
    const product = await newProduct('race_stock', 5);
    const body = { items: [{ pid: product.pid, qty: 4 }] };
    const responses = await Promise.all([api('POST', '/api/orders', body, buyer.token), api('POST', '/api/orders', body, buyer.token)]);
    assert.deepEqual(responses.map(row => row.status).sort(), [201, 409]);
    assert.equal(await quantity(product.pid), 1);
    const orders = (await pool.query('SELECT oid FROM orders WHERE uid=$1', [buyer.uid])).rows;
    assert.equal(orders.length, 1);
    return { uid: buyer.uid, pid: product.pid, statuses: responses.map(row => row.status), oid: orders[0].oid, stock: 1 };
  });

  await check('PostgreSQL insert failure restores Mongo stock and rolls back Order/Outbox', async () => {
    const buyer = await newBuyer('pg_failure');
    const product = await newProduct('pg_failure_stock', 9);
    const suffix = randomUUID().replaceAll('-', '');
    const trigger = `res_fail_${suffix}`;
    const fn = `res_fail_fn_${suffix}`;
    // Identifiers are generated hex; the trigger only affects this new test user.
    await pool.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.uid = ${buyer.uid} THEN RAISE EXCEPTION 'controlled resilience test failure'; END IF; RETURN NEW; END $$`);
    try {
      await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      const response = await api('POST', '/api/orders', { items: [{ pid: product.pid, qty: 3 }] }, buyer.token, 500);
      assert.equal(response.status, 500);
      assert.equal(await quantity(product.pid), 9);
      const attempts = (await pool.query('SELECT operation_id,state FROM order_attempts WHERE uid=$1', [buyer.uid])).rows;
      assert.equal(attempts.length, 1); assert.equal(attempts[0].state, 'ABORTED');
      assert.equal(Number((await pool.query('SELECT count(*) FROM orders WHERE uid=$1', [buyer.uid])).rows[0].count), 0);
      assert.equal(Number((await pool.query('SELECT count(*) FROM outbox_events o JOIN orders r ON r.oid=o.aggregate_id WHERE r.uid=$1', [buyer.uid])).rows[0].count), 0);
      const operation = await inventory('GetInventoryOperation', { operationId: attempts[0].operation_id });
      assert.equal(operation.state, 'CANCELLED');
      return { uid: buyer.uid, pid: product.pid, http: 500, stock: 9, attempt: 'ABORTED', orderCount: 0, outboxCount: 0 };
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON orders`);
      await pool.query(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  });

  await check('Recovery worker compensates a durable expired attempt after inventory was applied', async () => {
    const buyer = await newBuyer('recovery');
    const product = await newProduct('recovery_stock', 12);
    const operationId = randomUUID();
    const items = [{ pid: product.pid, qty: 4 }];
    await pool.query("INSERT INTO order_attempts(operation_id,uid,request,score,state,lease_until) VALUES($1,$2,$3,0,'PREPARED',now()+interval '60 seconds')", [operationId, buyer.uid, JSON.stringify({ items })]);
    await inventory('ApplyInventory', { operationId, items });
    assert.equal(await quantity(product.pid), 8);
    // Persisted records represent the exact crash boundary after Apply and before Order commit.
    await pool.query("UPDATE order_attempts SET lease_until=now()-interval '1 second' WHERE operation_id=$1", [operationId]);
    await eventually(async () => (await pool.query('SELECT state FROM order_attempts WHERE operation_id=$1', [operationId])).rows[0]?.state === 'ABORTED', 'Order recovery to ABORTED');
    assert.equal(await quantity(product.pid), 12);
    assert.equal((await inventory('GetInventoryOperation', { operationId })).state, 'CANCELLED');
    assert.equal(Number((await pool.query('SELECT count(*) FROM orders WHERE operation_id=$1', [operationId])).rows[0].count), 0);
    return { uid: buyer.uid, operationId, restoredStock: 12, state: 'ABORTED', orderCount: 0 };
  });

  await check('ABORTING row lock guard rejects a stale Order commit', async () => {
    const buyer = await newBuyer('stale_commit');
    const product = await newProduct('stale_stock', 7);
    const operationId = randomUUID();
    const items = [{ pid: product.pid, qty: 2 }];
    await pool.query("INSERT INTO order_attempts(operation_id,uid,request,score,state,lease_until) VALUES($1,$2,$3,0,'PREPARED',now()+interval '60 seconds')", [operationId, buyer.uid, JSON.stringify({ items })]);
    const applied = await inventory('ApplyInventory', { operationId, items });
    const repository = new OrderRepository(pool);
    assert.equal(await repository.claimAbort(operationId), 'ABORTING');
    await assert.rejects(() => repository.commit(operationId, applied.items, calculateTotals(applied.items, 0, parsePolicy(process.env.DISCOUNT_POLICY))), error => error.status === 409);
    await inventory('CancelInventory', { operationId });
    await repository.finishAbort(operationId);
    assert.equal(await quantity(product.pid), 7);
    assert.equal(Number((await pool.query('SELECT count(*) FROM orders WHERE operation_id=$1', [operationId])).rows[0].count), 0);
    return { operationId, state: 'ABORTED', stock: 7, staleCommitRejected: true };
  });

  console.log(JSON.stringify({ suite: 'real-infrastructure-resilience', runId, passed: results.length, failed: 0 }));
} catch (error) {
  console.error(JSON.stringify({ suite: 'real-infrastructure-resilience', runId, passed: results.length, failed: 1, error: error.message, stack: error.stack }));
  process.exitCode = 1;
} finally {
  productClient.close();
  await mongo.close().catch(() => {});
  await pool.end().catch(() => {});
}
