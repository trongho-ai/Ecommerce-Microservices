import { createClient, request } from '../shared/grpc.js';
const service = process.env.SERVICE;
if (service === 'api-gateway') {
  const response = await fetch('http://127.0.0.1:3000/api/health', { signal: AbortSignal.timeout(6000) });
  if (!response.ok) process.exit(1);
} else {
  const name = service.replace('-service', '');
  const client = createClient(name, `${name[0].toUpperCase()}${name.slice(1)}Service`, '127.0.0.1:50051');
  try { await request(client, 'Health', {}, null, { timeout: 6000 }); }
  catch { process.exitCode = 1; }
  finally { client.close(); }
}
