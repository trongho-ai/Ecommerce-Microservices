import { Kafka, logLevel } from 'kafkajs';
export const ORDER_TOPIC = process.env.ORDER_TOPIC || 'order-created';
export function kafkaClient(clientId) {
  return new Kafka({ clientId, brokers: (process.env.KAFKA_BROKERS || 'kafka:9092').split(','), logLevel: logLevel.ERROR, connectionTimeout: 3000, requestTimeout: 5000, retry: { retries: 3, initialRetryTime: 200 } });
}
