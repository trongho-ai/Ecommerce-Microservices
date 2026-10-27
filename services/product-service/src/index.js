import { startGrpc } from '../../../shared/grpc.js';
import { productApplication } from './application/product-service.js';
import { connectProductRepository } from './infrastructure/product-repository.js';
import { productHandlers } from './interfaces/grpc-handlers.js';

const repository = await connectProductRepository();
const application = productApplication(repository);
const server = await startGrpc('product', 'ProductService', productHandlers(application), () => repository.health());

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.tryShutdown(async () => { await repository.client.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 5000).unref();
  });
}
