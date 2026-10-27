import pg from 'pg';
import { createClient, request, startGrpc } from '../../../shared/grpc.js';
import { AppError } from '../../../shared/errors.js';
import { migrateAuth, userRepository } from './infrastructure/user-repository.js';
import { authApplication } from './application/auth.js';
import { authHandlers } from './interfaces/grpc-handlers.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
pool.on('error', error => console.error(JSON.stringify({ service: 'auth', databaseError: error.message })));
await migrateAuth(pool);
const customer = createClient('customer', 'CustomerService', process.env.CUSTOMER_GRPC || 'customer-service:50051');
// Leave time for the outer Gateway RPC to return a clear pending/503 response.
const application = authApplication(userRepository(pool), input => request(customer, 'EnsureCustomer', input, { uid: input.uid, role: 'SYSTEM' }, { timeout: 2000 }), {
  jwtSecret: process.env.JWT_SECRET,
  jwtTtl: Number(process.env.JWT_TTL_SECONDS || 3600),
});
const server = await startGrpc('auth', 'AuthService', authHandlers(application), async () => {
  try { await pool.query('SELECT 1'); }
  catch { throw new AppError(503, 'Auth database unavailable'); }
});

let retryRunning = false;
const retry = setInterval(async () => {
  if (retryRunning) return;
  retryRunning = true;
  try { await application.retryProvisioning(); }
  catch (error) { console.error(JSON.stringify({ service: 'auth', operation: 'provisionRetry', error: error.message })); }
  finally { retryRunning = false; }
}, 2000);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(retry);
  await new Promise(resolve => server.tryShutdown(resolve));
  customer.close();
  await pool.end();
}
process.on('SIGTERM', () => stop().catch(console.error));
process.on('SIGINT', () => stop().catch(console.error));
