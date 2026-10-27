import { MongoClient } from 'mongodb';
import { startGrpc } from '../../../shared/grpc.js';
import { AppError } from '../../../shared/errors.js';
import { kafkaClient, ORDER_TOPIC } from '../../../shared/kafka.js';
import { ShipmentRepository } from './infrastructure/repository.js';
import { ShipmentConsumer } from './infrastructure/consumer.js';
import { ShipmentApplication } from './application/shipments.js';
import { shipmentHandlers } from './interfaces/handlers.js';

const mongo = new MongoClient(process.env.MONGO_URL || 'mongodb://shipment-db:27017', { serverSelectionTimeoutMS: 3000 });
await mongo.connect();
const repository = new ShipmentRepository(mongo.db(process.env.MONGO_DATABASE || 'shipment'));
await repository.migrate();
const kafka = kafkaClient('shipment-service');
const consumer = new ShipmentConsumer(repository, kafka);
const admin = kafka.admin();
let adminConnected = false;
const health = async () => {
  await repository.health();
  if (!consumer.ready) throw new AppError(503, 'Shipment consumer is not ready');
  try {
    if (!adminConnected) { await admin.connect(); adminConnected = true; }
    await admin.fetchTopicMetadata({ topics: [ORDER_TOPIC] });
  } catch (error) { adminConnected = false; throw new AppError(503, 'Kafka is unavailable'); }
};
const server = await startGrpc('shipment', 'ShipmentService', shipmentHandlers(new ShipmentApplication(repository)), health);
consumer.start();
const reconnectTimer = setInterval(() => consumer.start(), 2000);
async function stop() {
  clearInterval(reconnectTimer); server.forceShutdown();
  await consumer.close().catch(() => {}); await admin.disconnect().catch(() => {});
  await mongo.close(); process.exit(0);
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
