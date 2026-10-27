import pg from 'pg';
import { createClient, request, startGrpc } from '../../../shared/grpc.js';
import { AppError } from '../../../shared/errors.js';
import { kafkaClient, ORDER_TOPIC } from '../../../shared/kafka.js';
import { parsePolicy } from './domain/order.js';
import { OrderRepository } from './infrastructure/repository.js';
import { OutboxPublisher } from './infrastructure/outbox.js';
import { OrderApplication } from './application/orders.js';
import { orderHandlers } from './interfaces/handlers.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000, query_timeout: 10000, max: 10 });
// Idle PostgreSQL sockets can emit errors during a DB restart. Keep the service
// alive so health reports failure and the durable recovery loop can resume later.
pool.on('error', error => console.error(JSON.stringify({ service: 'order', dependency: 'postgres', error: error.message })));
const repository = new OrderRepository(pool);
await repository.migrate();
const clients = { customer: createClient('customer', 'CustomerService', process.env.CUSTOMER_GRPC || 'customer-service:50051'), product: createClient('product', 'ProductService', process.env.PRODUCT_GRPC || 'product-service:50051'), shipment: createClient('shipment', 'ShipmentService', process.env.SHIPMENT_GRPC || 'shipment-service:50051') };
const dependencies = Object.fromEntries(Object.entries(clients).map(([name, client]) => [name, (method, payload, actor, options) => request(client, method, payload, actor, options)]));
const application = new OrderApplication(repository, dependencies, parsePolicy(process.env.DISCOUNT_POLICY));
const kafka = kafkaClient('order-service');
const publisher = new OutboxPublisher(repository, kafka);
const brokerAdmin = kafka.admin();
let adminConnected = false;
const health = async () => {
  await repository.health();
  try {
    if (!adminConnected) { await brokerAdmin.connect(); adminConnected = true; }
    await brokerAdmin.fetchTopicMetadata({ topics: [ORDER_TOPIC] });
  } catch (error) { adminConnected = false; throw new AppError(503, 'Kafka is unavailable'); }
};
const server = await startGrpc('order', 'OrderService', orderHandlers(application), health);
let recovering = false;
const recover = async () => {
  if (recovering) return;
  recovering = true;
  try { await application.recover(); } catch (error) { console.error(JSON.stringify({ service: 'order', recoveryError: error.message })); }
  finally { recovering = false; }
};
const outboxTimer = setInterval(() => publisher.tick(), 1000);
const recoveryTimer = setInterval(recover, 5000);
publisher.tick();
recover();
async function stop() {
  clearInterval(outboxTimer); clearInterval(recoveryTimer);
  server.forceShutdown();
  await publisher.close(); await brokerAdmin.disconnect().catch(() => {});
  for (const client of Object.values(clients)) client.close();
  await pool.end(); process.exit(0);
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
