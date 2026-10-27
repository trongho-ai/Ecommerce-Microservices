import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import bcrypt from 'bcryptjs';
import { DEMO_ACCOUNTS } from '../scripts/fixtures.js';
import { EvidenceResources, http, independentDiscount, independentMoney, poll } from './integration-helpers.js';

const groups = ['auth', 'customer', 'product', 'order', 'shipment'];
const groupIndex = process.argv.indexOf('--group');
const group = groupIndex < 0 ? 'all' : process.argv[groupIndex + 1];
if (group !== 'all' && !groups.includes(group)) throw new Error(`Unknown group: ${group}; choose all or ${groups.join(', ')}`);

const resources = new EvidenceResources();
const startedAt = new Date().toISOString();
const results = [];
const context = {};
const freshName = prefix => `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
const include = name => group === 'all' || group === name;

async function run(id, description, action) {
  const start = Date.now();
  try {
    const evidence = await action();
    results.push({ id, description, status: 'PASS', durationMs: Date.now() - start, evidence });
    console.log(`PASS ${id}: ${description} ${JSON.stringify(evidence || {})}`);
  } catch (error) {
    results.push({ id, description, status: 'FAIL', durationMs: Date.now() - start, error: error.message });
    console.error(`FAIL ${id}: ${description}: ${error.message}`);
  }
}

async function account(role) {
  if (!context[`${role}Token`]) {
    const credentials = DEMO_ACCOUNTS[role];
    assert.ok(credentials, `Seed account ${role} is not configured`);
    const response = await http('POST', '/api/auth/login', { body: { username: credentials.username, password: credentials.password } });
    assert.equal(response.tokenType, 'Bearer');
    assert.ok(response.accessToken);
    context[`${role}Token`] = response.accessToken;
  }
  return context[`${role}Token`];
}

async function buyer() {
  if (!context.buyer) {
    const credentials = { username: freshName('tc'), password: 'TestPass123!' };
    const result = await http('POST', '/api/auth/register', { body: credentials, status: 201 });
    assert.ok(Number.isInteger(result.uid) && result.uid > 0);
    context.buyer = { ...credentials, uid: result.uid };
  }
  if (!context.buyer.token) {
    const login = await http('POST', '/api/auth/login', { body: { username: context.buyer.username, password: context.buyer.password } });
    context.buyer.token = login.accessToken;
  }
  return context.buyer;
}

async function goldBuyer() {
  const user = await buyer();
  await http('PUT', `/api/customers/${user.uid}`, { token: await account('admin'), body: { mid: 3 } });
  const membership = await http('GET', `/api/customers/${user.uid}/membership`, { token: user.token });
  assert.equal(membership.mid, 3);
  return { ...user, membership };
}

async function product() {
  if (!context.product) {
    const input = { pname: freshName('EvidenceProduct'), price: 12.35, quantity: 20 };
    context.product = await http('POST', '/api/products', { token: await account('admin'), body: input, status: 201 });
    assert.ok(context.product.pid > 0);
  }
  return context.product;
}

async function productDocument(pid) {
  return (await resources.mongo('product')).collection('products').findOne({ pid });
}

async function createOrder(qty = 1, { observe = false } = {}) {
  const user = await goldBuyer();
  const item = await product();
  if (observe) await resources.observeKafka();
  const before = await productDocument(item.pid);
  const order = await http('POST', '/api/orders', { token: user.token, body: { items: [{ pid: item.pid, qty }] }, status: 201 });
  assert.ok(Number.isInteger(order.oid) && order.oid > 0);
  const saved = await resources.pg('order').query('SELECT * FROM orders WHERE oid=$1', [order.oid]);
  assert.equal(saved.rowCount, 1);
  assert.equal(saved.rows[0].uid, user.uid);
  const details = await resources.pg('order').query('SELECT * FROM order_details WHERE oid=$1 ORDER BY pid', [order.oid]);
  assert.equal(details.rowCount, 1);
  assert.equal(details.rows[0].pid, item.pid);
  assert.equal(details.rows[0].qty, qty);
  const after = await productDocument(item.pid);
  assert.equal(after.quantity, before.quantity - qty, 'MongoDB quantity must be decremented by this real order');
  return { user, item, before, after, order, saved: saved.rows[0], details: details.rows };
}

async function evidenceOrderEvent() {
  if (!context.orderEvent) {
    const created = await createOrder(1, { observe: true });
    const eventId = created.saved.event_id;
    assert.equal(created.order.eventId, eventId);
    const message = await resources.event(eventId, created.order.oid);
    assert.equal(message.event.payload.uid, created.user.uid);
    assert.equal(message.event.payload.items[0].pid, created.item.pid);
    assert.equal(message.event.payload.items[0].qty, 1);
    assert.equal(independentMoney(message.event.payload.items[0].unit_price), independentMoney(created.details[0].unit_price));
    await poll(async () => (await resources.pg('order').query('SELECT status FROM outbox_events WHERE event_id=$1', [eventId])).rows[0], row => row?.status === 'SENT', { description: 'Outbox broker acknowledgement to be persisted' });
    const outbox = await resources.pg('order').query('SELECT * FROM outbox_events WHERE event_id=$1', [eventId]);
    assert.equal(outbox.rows[0].aggregate_id, created.order.oid);
    assert.equal(outbox.rows[0].payload.eventId, eventId);
    context.orderEvent = { ...created, ...message, eventId };
  }
  return context.orderEvent;
}

try {
  if (include('auth')) {
    await run('TC-IAM-01', 'Register a valid account; verify PostgreSQL and bcrypt', async () => {
      const credentials = { username: freshName('tc'), password: 'TestPass123!' };
      const result = await http('POST', '/api/auth/register', { body: credentials, status: 201 });
      assert.ok(Number.isInteger(result.uid) && result.uid > 0);
      context.buyer = { ...credentials, uid: result.uid };
      const rows = await resources.pg('auth').query('SELECT u.uid,u.username,u.password,r.rolename FROM users u JOIN roles r ON r.roleid=u.roleid WHERE u.uid=$1', [result.uid]);
      assert.equal(rows.rowCount, 1);
      assert.equal(rows.rows[0].username, credentials.username);
      assert.equal(rows.rows[0].rolename, 'CUSTOMER');
      assert.match(rows.rows[0].password, /^\$2[aby]\$/);
      assert.ok(await bcrypt.compare(credentials.password, rows.rows[0].password));
      assert.equal(Object.hasOwn(result, 'password'), false);
      return { uid: result.uid, userRows: rows.rowCount, passwordHashed: true };
    });
    await run('TC-IAM-02', 'Reject duplicate username without inserting another User', async () => {
      const user = await buyer();
      await http('POST', '/api/auth/register', { body: { username: user.username, password: user.password }, status: 409 });
      const rows = await resources.pg('auth').query('SELECT COUNT(*)::int AS count FROM users WHERE username=$1', [user.username]);
      assert.equal(rows.rows[0].count, 1);
      return { uid: user.uid, userRows: rows.rows[0].count, http: 409 };
    });
    await run('TC-IAM-03', 'Reject empty password with HTTP 400', async () => {
      const username = freshName('invalid');
      await http('POST', '/api/auth/register', { body: { username, password: '' }, status: 400 });
      const rows = await resources.pg('auth').query('SELECT COUNT(*)::int AS count FROM users WHERE username=$1', [username]);
      assert.equal(rows.rows[0].count, 0);
      return { http: 400, userRows: 0 };
    });
    await run('TC-IAM-04', 'Login returns JWT with matching subject and role', async () => {
      const user = await buyer();
      const login = await http('POST', '/api/auth/login', { body: { username: user.username, password: user.password } });
      assert.equal(login.tokenType, 'Bearer');
      assert.ok(Number.isInteger(login.expiresIn) && login.expiresIn > 0);
      const parts = login.accessToken.split('.');
      assert.equal(parts.length, 3);
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      assert.equal(Number(claims.sub), user.uid);
      assert.equal(claims.role, 'CUSTOMER');
      assert.ok(claims.exp > Date.now() / 1000);
      user.token = login.accessToken;
      return { uid: user.uid, role: claims.role, expiresIn: login.expiresIn };
    });
    await run('TC-IAM-05', 'Reject incorrect password with HTTP 401', async () => {
      const user = await buyer();
      await http('POST', '/api/auth/login', { body: { username: user.username, password: 'WrongPassword123!' }, status: 401 });
      return { http: 401 };
    });
  }

  if (include('customer')) {
    await run('TC-CUS-01', 'Read existing Customer; compare Customer PostgreSQL', async () => {
      const user = await buyer();
      const response = await http('GET', `/api/customers/${user.uid}`, { token: user.token });
      const saved = await resources.pg('customer').query('SELECT uid,fullname,mid FROM customers WHERE uid=$1', [user.uid]);
      assert.equal(saved.rowCount, 1);
      assert.deepEqual({ uid: response.uid, fullname: response.fullname, mid: response.mid }, saved.rows[0]);
      return { uid: user.uid, mid: response.mid, customerRows: 1 };
    });
    await run('TC-CUS-02', 'Unknown Customer returns HTTP 404 to authorized Admin', async () => {
      const missing = 2147483647;
      const saved = await resources.pg('customer').query('SELECT uid FROM customers WHERE uid=$1', [missing]);
      assert.equal(saved.rowCount, 0);
      await http('GET', `/api/customers/${missing}`, { token: await account('admin'), status: 404 });
      return { uid: missing, http: 404 };
    });
    await run('TC-CUS-03', 'Update fullname and verify persisted value', async () => {
      const user = await buyer();
      const fullname = `Evidence ${randomUUID().slice(0, 8)}`;
      await http('PUT', `/api/customers/${user.uid}`, { token: user.token, body: { fullname } });
      const saved = await resources.pg('customer').query('SELECT fullname FROM customers WHERE uid=$1', [user.uid]);
      assert.equal(saved.rows[0].fullname, fullname);
      const response = await http('GET', `/api/customers/${user.uid}`, { token: user.token });
      assert.equal(response.fullname, fullname);
      return { uid: user.uid, fullname };
    });
    await run('TC-CUS-04', 'Read Membership mname and score using real Customer mid', async () => {
      const user = await goldBuyer();
      const saved = await resources.pg('customer').query('SELECT m.mid,m.mname,m.score FROM customers c JOIN memberships m ON m.mid=c.mid WHERE c.uid=$1', [user.uid]);
      assert.equal(saved.rowCount, 1);
      assert.deepEqual({ mid: user.membership.mid, mname: user.membership.mname, score: user.membership.score }, saved.rows[0]);
      return { uid: user.uid, ...saved.rows[0], source: 'Customer PostgreSQL JOIN' };
    });
    await run('TC-CUS-05', 'Customer request without JWT returns HTTP 401', async () => {
      const user = await buyer();
      await http('GET', `/api/customers/${user.uid}`, { status: 401 });
      return { uid: user.uid, http: 401, authorizationHeader: false };
    });
  }

  if (include('product')) {
    await run('TC-PRO-01', 'List Products with JWT and compare MongoDB values', async () => {
      const user = await buyer();
      const fixture = await product();
      const response = await http('GET', '/api/products', { token: user.token });
      assert.ok(Array.isArray(response.items) && response.items.length > 0);
      const item = response.items.find(value => value.pid === fixture.pid);
      assert.ok(item, 'The product created through the real Admin API must appear in the list');
      const saved = await productDocument(fixture.pid);
      assert.equal(item.pname, saved.pname);
      assert.equal(independentMoney(item.price), independentMoney(saved.price));
      assert.equal(item.quantity, saved.quantity);
      return { pid: item.pid, quantity: item.quantity, returnedItems: response.items.length, source: 'Product MongoDB' };
    });
    await run('TC-PRO-02', 'Read existing Product', async () => {
      const user = await buyer();
      const fixture = await product();
      const response = await http('GET', `/api/products/${fixture.pid}`, { token: user.token });
      assert.equal(response.pid, fixture.pid);
      assert.equal(response.pname, fixture.pname);
      return { pid: response.pid, http: 200 };
    });
    await run('TC-PRO-03', 'Unknown Product returns HTTP 404', async () => {
      const user = await buyer();
      assert.equal(await productDocument(2147483647), null);
      await http('GET', '/api/products/2147483647', { token: user.token, status: 404 });
      return { http: 404 };
    });
    await run('TC-PRO-04', 'Admin creates Product with HTTP 201 and MongoDB row', async () => {
      const input = { pname: freshName('CreatedProduct'), price: 19.99, quantity: 7 };
      context.createdProduct = await http('POST', '/api/products', { token: await account('admin'), body: input, status: 201 });
      const saved = await productDocument(context.createdProduct.pid);
      assert.equal(saved.pname, input.pname);
      assert.equal(independentMoney(saved.price), 1999);
      assert.equal(saved.quantity, 7);
      return { pid: saved.pid, http: 201, quantity: saved.quantity };
    });
    await run('TC-PRO-05', 'Update quantity and verify MongoDB persisted stock', async () => {
      const fixture = context.createdProduct || await product();
      await http('PUT', `/api/products/${fixture.pid}`, { token: await account('admin'), body: { quantity: 11 } });
      const saved = await productDocument(fixture.pid);
      assert.equal(saved.quantity, 11);
      return { pid: fixture.pid, quantity: saved.quantity };
    });
  }

  if (include('order')) {
    await run('TC-ORD-01', 'Create Order and OrderDetail; verify SQL and actual stock decrease', async () => {
      const created = await createOrder(2);
      const outbox = await resources.pg('order').query('SELECT event_id FROM outbox_events WHERE aggregate_id=$1', [created.order.oid]);
      assert.equal(outbox.rowCount, 1);
      return { oid: created.order.oid, detailRows: created.details.length, stockBefore: created.before.quantity, stockAfter: created.after.quantity, outboxRows: 1 };
    });
    await run('TC-ORD-02', 'Order request without JWT returns HTTP 401 and writes no Order', async () => {
      const user = await buyer();
      const item = await product();
      const before = await resources.pg('order').query('SELECT COUNT(*)::int AS count FROM orders WHERE uid=$1', [user.uid]);
      await http('POST', '/api/orders', { body: { items: [{ pid: item.pid, qty: 1 }] }, status: 401 });
      const after = await resources.pg('order').query('SELECT COUNT(*)::int AS count FROM orders WHERE uid=$1', [user.uid]);
      assert.equal(after.rows[0].count, before.rows[0].count);
      return { http: 401, orderRowsUnchanged: true };
    });
    await run('TC-ORD-03', 'Insufficient stock returns HTTP 409 without Order or stock change', async () => {
      const user = await goldBuyer();
      const item = await product();
      const beforeStock = await productDocument(item.pid);
      const before = await resources.pg('order').query('SELECT COUNT(*)::int AS count FROM orders WHERE uid=$1', [user.uid]);
      await http('POST', '/api/orders', { token: user.token, body: { items: [{ pid: item.pid, qty: beforeStock.quantity + 1 }] }, status: 409 });
      const after = await resources.pg('order').query('SELECT COUNT(*)::int AS count FROM orders WHERE uid=$1', [user.uid]);
      assert.equal(after.rows[0].count, before.rows[0].count);
      assert.equal((await productDocument(item.pid)).quantity, beforeStock.quantity);
      return { http: 409, quantity: beforeStock.quantity, orderRowsUnchanged: true };
    });
    await run('TC-ORD-04', 'Discount follows real Membership score and configured demo policy', async () => {
      const created = await createOrder(3);
      const membership = await resources.pg('customer').query('SELECT m.score FROM customers c JOIN memberships m ON m.mid=c.mid WHERE c.uid=$1', [created.user.uid]);
      const score = membership.rows[0].score;
      const subtotal = created.details.reduce((sum, item) => sum + independentMoney(item.unit_price) * item.qty, 0);
      const expected = independentDiscount(subtotal, score);
      assert.equal(independentMoney(created.order.subtotal), subtotal);
      assert.equal(independentMoney(created.order.discount), expected.discount);
      assert.equal(independentMoney(created.order.total_amount), subtotal - expected.discount);
      assert.equal(independentMoney(created.saved.discount), expected.discount);
      assert.equal(created.saved.score, score);
      assert.equal(created.saved.discount_rate, expected.rate);
      return { oid: created.order.oid, score, rate: expected.rate, subtotalMinor: subtotal, expectedDiscountMinor: expected.discount, actualDiscountMinor: independentMoney(created.saved.discount) };
    });
    await run('TC-ORD-05', 'Persist Order and observe matching OrderCreated on real Kafka', async () => {
      const event = await evidenceOrderEvent();
      return { oid: event.order.oid, eventId: event.eventId, topic: event.topic, partition: event.partition, offset: event.offset, outboxStatus: 'SENT' };
    });
  }

  if (include('shipment')) {
    await run('TC-SHP-01', 'OrderCreated consumer creates a PENDING Shipment in MongoDB', async () => {
      const created = await evidenceOrderEvent();
      const db = await resources.mongo('shipment');
      const shipment = await poll(() => db.collection('shipments').findOne({ sourceEventId: created.eventId }), Boolean, { description: 'Shipment document for the new OrderCreated' });
      assert.equal(shipment.oid, created.order.oid);
      assert.equal(shipment.uid, created.user.uid);
      assert.equal(shipment.status, 'PENDING');
      const response = await http('GET', `/api/shipments/${shipment.shipid}`, { token: created.user.token });
      assert.equal(response.status, 'PENDING');
      context.shipment = shipment;
      return { shipid: shipment.shipid, oid: shipment.oid, eventId: created.eventId, status: shipment.status };
    });
    await run('TC-SHP-02', 'Kafka event missing oid is rejected without creating Shipment', async () => {
      const original = await evidenceOrderEvent();
      const invalid = structuredClone(original.event);
      invalid.eventId = randomUUID();
      delete invalid.payload.oid;
      const raw = JSON.stringify(invalid);
      const hash = createHash('sha256').update(raw).digest('hex');
      await resources.publish(raw, invalid.eventId);
      const db = await resources.mongo('shipment');
      const rejected = await poll(() => db.collection('rejected_events').findOne({ _id: hash }), Boolean, { description: 'durable invalid-event rejection' });
      assert.ok(rejected.reason);
      assert.equal(await db.collection('shipments').countDocuments({ sourceEventId: invalid.eventId }), 0);
      return { eventId: invalid.eventId, rejectedHash: hash, shipmentRows: 0, reason: rejected.reason };
    });
    await run('TC-SHP-03', 'Shipment Staff updates status to SHIPPING', async () => {
      const created = await evidenceOrderEvent();
      const db = await resources.mongo('shipment');
      const shipment = context.shipment || await poll(() => db.collection('shipments').findOne({ sourceEventId: created.eventId }), Boolean, { description: 'Shipment before status update' });
      const response = await http('PATCH', `/api/shipments/${shipment.shipid}/status`, { token: await account('staff'), body: { status: 'SHIPPING' } });
      assert.equal(response.status, 'SHIPPING');
      assert.equal((await db.collection('shipments').findOne({ shipid: shipment.shipid })).status, 'SHIPPING');
      return { shipid: shipment.shipid, status: 'SHIPPING' };
    });
    await run('TC-SHP-04', 'Updating nonexistent Shipment returns HTTP 404', async () => {
      const db = await resources.mongo('shipment');
      assert.equal(await db.collection('shipments').findOne({ shipid: 2147483647 }), null);
      await http('PATCH', '/api/shipments/2147483647/status', { token: await account('staff'), body: { status: 'SHIPPING' }, status: 404 });
      return { http: 404 };
    });
    await run('TC-SHP-05', 'Replaying exactly the same Kafka event does not duplicate Shipment', async () => {
      const created = await evidenceOrderEvent();
      await resources.publish(created.raw, String(created.order.oid));
      await resources.publish(created.raw, String(created.order.oid));
      await resources.waitShipmentCaughtUp();
      const db = await resources.mongo('shipment');
      const count = await db.collection('shipments').countDocuments({ sourceEventId: created.eventId });
      assert.equal(count, 1);
      return { oid: created.order.oid, eventId: created.eventId, replayedMessages: 2, shipmentRows: count, consumerOffsetsCaughtUp: true };
    });
  }
} catch (error) {
  results.push({ id: 'SETUP', status: 'FAIL', error: error.message });
  console.error(`FAIL SETUP: ${error.message}`);
} finally {
  await resources.close();
}

const report = { startedAt, finishedAt: new Date().toISOString(), group, total: results.length, passed: results.filter(result => result.status === 'PASS').length, failed: results.filter(result => result.status === 'FAIL').length, results };
if (process.env.REPORT_PATH) {
  await mkdir(dirname(process.env.REPORT_PATH), { recursive: true });
  await writeFile(process.env.REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Evidence report: ${process.env.REPORT_PATH}`);
}
console.log(`Integration ${group}: ${report.passed}/${report.total} PASS; ${report.failed} FAIL`);
const expectedCount = group === 'all' ? 25 : 5;
if (report.failed || report.total !== expectedCount) process.exitCode = 1;
