import pg from 'pg';
import { startGrpc } from '../../../shared/grpc.js';
import { AppError } from '../../../shared/errors.js';
import { migrateCustomer, customerRepository } from './infrastructure/customer-repository.js';
import { customerApplication } from './application/customer.js';
import { customerHandlers } from './interfaces/grpc-handlers.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
pool.on('error', error => console.error(JSON.stringify({ service: 'customer', databaseError: error.message })));
await migrateCustomer(pool);
const server = await startGrpc('customer', 'CustomerService', customerHandlers(customerApplication(customerRepository(pool))), async () => {
  try { await pool.query('SELECT 1'); }
  catch { throw new AppError(503, 'Customer database unavailable'); }
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise(resolve => server.tryShutdown(resolve));
  await pool.end();
}
process.on('SIGTERM', () => stop().catch(console.error));
process.on('SIGINT', () => stop().catch(console.error));
