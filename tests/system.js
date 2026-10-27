// Real Redis/API security and lifecycle checks in the Compose tools container.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import jwt from 'jsonwebtoken';
import { createClient } from 'redis';
import { DEMO_ACCOUNTS } from '../scripts/fixtures.js';
import { http, poll, EvidenceResources } from './integration-helpers.js';

const resources = new EvidenceResources();
const redis = createClient({ url: process.env.REDIS_URL });
redis.on('error', () => {});
let passed = 0;
const base = process.env.API_BASE_URL || 'http://api-gateway:3000';
async function check(name, action) { const evidence = await action(); passed++; console.log(JSON.stringify({ name, status: 'PASS', evidence })); }
try {
  await redis.connect();
  const customer = await http('POST', '/api/auth/login', { body: DEMO_ACCOUNTS.customer });
  const admin = await http('POST', '/api/auth/login', { body: DEMO_ACCOUNTS.admin });
  const uid = Number(jwt.decode(customer.accessToken).sub);
  const adminUid = Number(jwt.decode(admin.accessToken).sub);
  await check('Aggregate health checks all required services', async () => {
    const result = await http('GET', '/api/health');
    assert.equal(result.status, 'UP');
    assert.equal(Object.keys(result.dependencies).length, 6);
    assert.ok(Object.values(result.dependencies).every(value => value === 'UP'));
    return result.dependencies;
  });
  await check('Invalid/expired JWT and self-selected role are rejected', async () => {
    await http('GET', `/api/customers/${uid}`, { token: 'invalid.jwt.value', status: 401 });
    const expired = jwt.sign({ role: 'CUSTOMER' }, process.env.JWT_SECRET, { algorithm: 'HS256', subject: String(uid), issuer: 'ecommerce-auth', audience: 'ecommerce-api', expiresIn: -10 });
    await http('GET', `/api/customers/${uid}`, { token: expired, status: 401 });
    await http('POST', '/api/auth/register', { body: { username: `role_${randomUUID().slice(0, 8)}`, password: 'TestPass123!', role: 'ADMIN' }, status: 400 });
    return { invalidJwt: 401, expiredJwt: 401, roleInRegister: 400 };
  });
  await check('Customer cannot manage Product, other Customer or its own tier', async () => {
    await http('POST', '/api/products', { token: customer.accessToken, body: { pname: 'forbidden', price: 10, quantity: 1 }, status: 403 });
    await http('GET', `/api/customers/${adminUid}`, { token: customer.accessToken, status: 403 });
    await http('PUT', `/api/customers/${uid}`, { token: customer.accessToken, body: { mid: 2 }, status: 403 });
    return { adminWrite: 403, otherCustomer: 403, selfUpgrade: 403 };
  });
  await check('JWT cache in Redis contains verified claims and bounded TTL', async () => {
    await http('GET', `/api/customers/${uid}`, { token: customer.accessToken });
    const key = `token:${createHash('sha256').update(customer.accessToken).digest('hex')}`;
    const value = JSON.parse(await redis.get(key));
    const ttl = await redis.ttl(key);
    assert.equal(value.uid, uid); assert.equal(value.role, 'CUSTOMER');
    assert.ok(ttl > 0 && ttl <= 60 && ttl <= value.exp - Math.floor(Date.now() / 1000));
    assert.equal(Object.hasOwn(value, 'password'), false);
    return { uid, cached: true, ttlSeconds: ttl };
  });
  await check('A cached short-lived token stops authorizing at expiry', async () => {
    const token = jwt.sign({ role: 'CUSTOMER' }, process.env.JWT_SECRET, { algorithm: 'HS256', subject: String(uid), issuer: 'ecommerce-auth', audience: 'ecommerce-api', expiresIn: 3 });
    await http('GET', `/api/customers/${uid}`, { token });
    await poll(async () => Math.floor(Date.now() / 1000), now => now >= jwt.decode(token).exp, { timeout: 6000, description: 'short-lived token expiry' });
    await http('GET', `/api/customers/${uid}`, { token, status: 401 });
    return { tokenExpired: true, http: 401 };
  });
  await check('Product DELETE hides persisted product from API reads', async () => {
    const product = await http('POST', '/api/products', { token: admin.accessToken, body: { pname: `delete_${randomUUID().slice(0, 8)}`, price: '1.25', quantity: 2 }, status: 201 });
    await http('DELETE', `/api/products/${product.pid}`, { token: admin.accessToken });
    await http('GET', `/api/products/${product.pid}`, { token: admin.accessToken, status: 404 });
    const stored = await (await resources.mongo('product')).collection('products').findOne({ pid: product.pid });
    assert.equal(stored.deleted, true);
    return { pid: product.pid, deleted: true, getHttp: 404 };
  });
  await check('Order rejects client-supplied price/discount without persistence', async () => {
    const before = Number((await resources.pg('order').query('SELECT count(*) FROM orders WHERE uid=$1', [uid])).rows[0].count);
    await http('POST', '/api/orders', { token: customer.accessToken, body: { items: [{ pid: 1, qty: 1 }], discount: 999 }, status: 400 });
    await http('POST', '/api/orders', { token: customer.accessToken, body: { items: [{ pid: 1, qty: 1, unit_price: 0 }] }, status: 400 });
    const after = Number((await resources.pg('order').query('SELECT count(*) FROM orders WHERE uid=$1', [uid])).rows[0].count);
    assert.equal(after, before);
    return { tamperedFields: 400, orderCountUnchanged: true };
  });
  await check('Rate limiter increments Redis for actual requests and returns 429', async () => {
    const maximum = Number(process.env.RATE_LIMIT_MAX || 120);
    const addresses = Object.values(networkInterfaces()).flat().filter(item => item.family === 'IPv4').map(item => item.address);
    // This tools container has its own source IP. Only its ephemeral rate key is restored.
    let rateKey;
    let original;
    for (const address of addresses) {
      const key = `rate:${address}`;
      const value = await redis.get(key);
      if (value !== null) { rateKey = key; original = { value, ttl: await redis.ttl(key) }; break; }
    }
    assert.ok(rateKey, 'Find the rate key for this test container source IP');
    const initial = Number(original.value);
    assert.ok(initial < maximum, 'Run system tests after the current rate window expires');
    let limited = false;
    let count = 0;
    try {
      for (; count <= maximum; count++) {
        const response = await fetch(`${base}/api/customers/${uid}`, { headers: { Authorization: `Bearer ${customer.accessToken}` }, signal: AbortSignal.timeout(5000) });
        await response.text();
        if (response.status === 429) { limited = true; break; }
        assert.equal(response.status, 200);
      }
      assert.equal(limited, true);
      assert.ok(Number(await redis.get(rateKey)) > maximum);
      return { requestsUntilLimited: count + 1, configuredLimit: maximum, http: 429, redisCounterIncremented: true };
    } finally {
      if (original.ttl > 0) await redis.set(rateKey, original.value, { EX: original.ttl });
      else await redis.del(rateKey);
    }
  });
  console.log(JSON.stringify({ suite: 'real-system-security-redis', passed, failed: 0 }));
} catch (error) { console.error(JSON.stringify({ suite: 'real-system-security-redis', passed, failed: 1, error: error.message })); process.exitCode = 1; }
finally { await redis.quit().catch(() => {}); await resources.close(); }
