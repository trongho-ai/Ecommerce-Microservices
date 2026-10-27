import express from 'express';
import { createClient as redisClient } from 'redis';
import { createHash, randomUUID } from 'node:crypto';
import { createClient, request } from '../../../shared/grpc.js';
import { AppError, fail, positiveId } from '../../../shared/errors.js';

const redis = redisClient({ url: process.env.REDIS_URL, disableOfflineQueue: true, commandsQueueMaxLength: 200, socket: { connectTimeout: 3000, reconnectStrategy: retries => Math.min(retries * 200, 3000) } });
redis.on('error', error => console.error(JSON.stringify({ service: 'api-gateway', dependency: 'redis', error: error.message })));
await redis.connect();
const clients = Object.fromEntries(['auth', 'customer', 'product', 'order', 'shipment'].map(name => [name, createClient(name, `${name[0].toUpperCase()}${name.slice(1)}Service`, process.env[`${name.toUpperCase()}_GRPC`] || `${name}-service:50051`)]));
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  const correlationId = randomUUID();
  res.setHeader('X-Request-Id', correlationId);
  res.setHeader('Cache-Control', 'no-store');
  const start = Date.now();
  res.on('finish', () => console.log(JSON.stringify({ service: 'api-gateway', requestId: correlationId, method: req.method, path: req.path, status: res.statusCode, elapsedMs: Date.now() - start })));
  next();
});
app.get('/api/health', async (req, res) => {
  const result = await Promise.allSettled([
    ...Object.entries(clients).map(async ([name, client]) => { await request(client, 'Health', {}, null, { timeout: 5000 }); return name; }),
    (async () => { if (!redis.isReady) throw new Error('Redis unavailable'); await redis.ping(); return 'redis'; })(),
  ]);
  const names = [...Object.keys(clients), 'redis'];
  const dependencies = Object.fromEntries(result.map((entry, index) => [names[index], entry.status === 'fulfilled' ? 'UP' : 'DOWN']));
  const healthy = result.every(entry => entry.status === 'fulfilled');
  res.status(healthy ? 200 : 503).json({ status: healthy ? 'UP' : 'DOWN', message: healthy ? 'E-commerce API is running' : 'Required dependency unavailable', dependencies });
});
const maxRequests = Number(process.env.RATE_LIMIT_MAX || 120);
const windowSeconds = Number(process.env.RATE_LIMIT_WINDOW_SECONDS || 60);
if (!Number.isInteger(maxRequests) || maxRequests < 1 || !Number.isInteger(windowSeconds) || windowSeconds < 1) throw new Error('Invalid rate limit configuration');
app.use('/api', async (req, res, next) => {
  try {
    if (!redis.isReady) fail(503, 'Rate limiting dependency unavailable');
    const key = `rate:${req.ip}`;
    const count = await redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n", { keys: [key], arguments: [String(windowSeconds)] });
    res.setHeader('X-RateLimit-Limit', String(maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, maxRequests - Number(count))));
    if (Number(count) > maxRequests) { res.setHeader('Retry-After', String(windowSeconds)); fail(429, 'Too many requests'); }
    next();
  } catch (error) { next(error instanceof AppError ? error : new AppError(503, 'Redis unavailable')); }
});
app.use(express.json({ limit: '64kb' }));
function fields(body, allowed) {
  if (!body || Array.isArray(body) || typeof body !== 'object') fail(400, 'A JSON object is required');
  if (Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'Unexpected request field');
  return body;
}
function id(value, name) { if (!/^\d+$/.test(value)) fail(400, `${name} must be a positive integer`); return positiveId(Number(value), name); }
function string(value, name) { if (typeof value !== 'string') fail(400, `${name} must be a string`); return value; }
function integer(value, name) { if (!Number.isInteger(value) || value < 0 || value > 2147483647) fail(400, `${name} must be a non-negative integer`); return value; }
function price(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') fail(400, 'price must be a decimal number');
  return String(value);
}
const route = handler => async (req, res, next) => { try { await handler(req, res); } catch (error) { next(error); } };
app.post('/api/auth/register', route(async (req, res) => {
  const body = fields(req.body, ['username', 'password', 'email', 'phone']);
  for (const key of Object.keys(body)) string(body[key], key);
  res.status(201).json(await request(clients.auth, 'Register', body));
}));
app.post('/api/auth/login', route(async (req, res) => {
  const body = fields(req.body, ['username', 'password']);
  for (const key of Object.keys(body)) string(body[key], key);
  res.json(await request(clients.auth, 'Login', body));
}));
app.use('/api', async (req, res, next) => {
  try {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
    if (!match) fail(401, 'Bearer token is required');
    const token = match[1];
    const cacheKey = `token:${createHash('sha256').update(token).digest('hex')}`;
    if (!redis.isReady) fail(503, 'Authentication cache unavailable');
    let actor;
    const cached = await redis.get(cacheKey);
    if (cached) {
      try { actor = JSON.parse(cached); } catch { await redis.del(cacheKey); }
      if (!actor?.uid || !actor?.role || !Number.isFinite(actor?.exp) || actor.exp <= Math.floor(Date.now() / 1000)) { actor = null; await redis.del(cacheKey); }
    }
    if (!actor) {
      actor = await request(clients.auth, 'VerifyToken', { token });
      const ttl = Math.min(60, Number(actor.exp) - Math.floor(Date.now() / 1000));
      if (ttl < 1) fail(401, 'Token expired');
      await redis.set(cacheKey, JSON.stringify(actor), { EX: ttl });
    }
    req.actor = actor;
    next();
  } catch (error) { next(error instanceof AppError ? error : new AppError(503, 'Authentication dependency unavailable')); }
});
function productJSON(product) { return { pid: product.pid, pname: product.pname, price: Number(product.price), quantity: product.quantity }; }
function shipmentJSON(shipment) { return { shipid: shipment.shipid, oid: shipment.oid, status: shipment.status }; }
function orderJSON(order) {
  return { ...order, discount: Number(order.discount), subtotal: Number(order.subtotal), total_amount: Number(order.total_amount), items: order.items.map(item => ({ ...item, unit_price: Number(item.unit_price) })), shipments: order.shipments.map(shipmentJSON) };
}
app.get('/api/customers/:uid/membership', route(async (req, res) => res.json(await request(clients.customer, 'GetMembership', { uid: id(req.params.uid, 'uid') }, req.actor))));
app.get('/api/customers/:uid', route(async (req, res) => res.json(await request(clients.customer, 'GetCustomer', { uid: id(req.params.uid, 'uid') }, req.actor))));
app.put('/api/customers/:uid', route(async (req, res) => {
  const body = fields(req.body, ['fullname', 'mid']);
  if (Object.hasOwn(body, 'fullname')) string(body.fullname, 'fullname');
  if (Object.hasOwn(body, 'mid')) positiveId(body.mid, 'mid');
  const customer = await request(clients.customer, 'UpdateCustomer', { uid: id(req.params.uid, 'uid'), ...body }, req.actor);
  res.json({ message: 'Customer updated successfully', ...customer });
}));
app.get('/api/products', route(async (req, res) => { const data = await request(clients.product, 'ListProducts', {}, req.actor); res.json({ items: data.items.map(productJSON) }); }));
app.get('/api/products/:pid', route(async (req, res) => res.json(productJSON(await request(clients.product, 'GetProduct', { pid: id(req.params.pid, 'pid') }, req.actor)))));
function productInput(body) {
  fields(body, ['pname', 'price', 'quantity']);
  if (Object.hasOwn(body, 'pname')) string(body.pname, 'pname');
  if (Object.hasOwn(body, 'price')) body.price = price(body.price);
  if (Object.hasOwn(body, 'quantity')) integer(body.quantity, 'quantity');
  return body;
}
app.post('/api/products', route(async (req, res) => {
  const body = productInput(req.body);
  if (!['pname', 'price', 'quantity'].every(key => Object.hasOwn(body, key))) fail(400, 'pname, price and quantity are required');
  res.status(201).json(productJSON(await request(clients.product, 'CreateProduct', body, req.actor)));
}));
app.put('/api/products/:pid', route(async (req, res) => {
  const body = productInput(req.body);
  const product = await request(clients.product, 'UpdateProduct', { pid: id(req.params.pid, 'pid'), ...body }, req.actor);
  res.json({ message: 'Product updated successfully', ...productJSON(product) });
}));
app.delete('/api/products/:pid', route(async (req, res) => {
  const product = await request(clients.product, 'DeleteProduct', { pid: id(req.params.pid, 'pid') }, req.actor);
  res.json({ message: 'Product deleted successfully', pid: product.pid });
}));
app.post('/api/orders', route(async (req, res) => {
  const body = fields(req.body, ['items']);
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) fail(400, 'items must contain 1 to 100 products');
  for (const item of body.items) { fields(item, ['pid', 'qty']); positiveId(item.pid, 'pid'); positiveId(item.qty, 'qty'); }
  const order = await request(clients.order, 'CreateOrder', body, req.actor, { timeout: 25000 });
  res.status(201).json(orderJSON(order));
}));
app.get('/api/orders', route(async (req, res) => { const data = await request(clients.order, 'ListOrders', {}, req.actor); res.json({ items: data.items.map(orderJSON) }); }));
app.get('/api/orders/:oid', route(async (req, res) => res.json(orderJSON(await request(clients.order, 'GetOrder', { oid: id(req.params.oid, 'oid') }, req.actor)))));
app.get('/api/shipments/:shipid', route(async (req, res) => res.json(shipmentJSON(await request(clients.shipment, 'GetShipment', { shipid: id(req.params.shipid, 'shipid') }, req.actor)))));
app.patch('/api/shipments/:shipid/status', route(async (req, res) => {
  const body = fields(req.body, ['status']);
  string(body.status, 'status');
  res.json(shipmentJSON(await request(clients.shipment, 'UpdateShipmentStatus', { shipid: id(req.params.shipid, 'shipid'), status: body.status }, req.actor)));
}));
app.use((req, res) => res.status(404).json({ message: 'Endpoint not found' }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error instanceof SyntaxError && 'body' in error ? 400 : error.status || 500;
  if (status >= 500) console.error(JSON.stringify({ service: 'api-gateway', error: error.message, path: req.path }));
  const message = error.businessCode === 'ORDER_RECOVERY_PENDING' ? 'Order completion is pending recovery. Check GET /api/orders before retrying.' : status >= 500 ? 'A required service is unavailable; check health and logs' : error.message;
  res.status(status).json({ message, ...(error.businessCode ? { code: error.businessCode } : {}) });
});
const server = app.listen(3000, '0.0.0.0', () => console.log(JSON.stringify({ service: 'api-gateway', port: 3000 })));
async function close() { server.close(); for (const client of Object.values(clients)) client.close(); await redis.quit().catch(() => {}); }
process.on('SIGTERM', () => close().finally(() => process.exit(0)));
process.on('SIGINT', () => close().finally(() => process.exit(0)));
