import grpc from '@grpc/grpc-js';
import loader from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import { AppError } from './errors.js';

export { grpc };
const protoDir = fileURLToPath(new URL('../proto/', import.meta.url));
const packages = new Map();
const statusMap = { 400: grpc.status.INVALID_ARGUMENT, 401: grpc.status.UNAUTHENTICATED, 403: grpc.status.PERMISSION_DENIED, 404: grpc.status.NOT_FOUND, 409: grpc.status.ABORTED, 429: grpc.status.RESOURCE_EXHAUSTED, 503: grpc.status.UNAVAILABLE, 504: grpc.status.DEADLINE_EXCEEDED };
export function loadProto(name) {
  if (!packages.has(name)) {
    const definition = loader.loadSync(`${protoDir}${name}.proto`, { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true, includeDirs: [protoDir] });
    packages.set(name, grpc.loadPackageDefinition(definition).ecommerce[name]);
  }
  return packages.get(name);
}
export function createClient(name, serviceName, address) {
  return new (loadProto(name)[serviceName])(address, grpc.credentials.createInsecure(), { 'grpc.max_receive_message_length': 4 * 1024 * 1024 });
}
export function request(client, method, payload = {}, actor = null, options = {}) {
  const metadata = new grpc.Metadata();
  metadata.set('x-internal-key', process.env.INTERNAL_KEY || '');
  if (actor) { metadata.set('x-user-id', String(actor.uid)); metadata.set('x-user-role', actor.role); }
  return new Promise((resolve, reject) => {
    client[method](payload, metadata, { deadline: Date.now() + (options.timeout ?? 5000) }, (error, value) => {
      if (!error) return resolve(value);
      const explicit = Number(error.metadata?.get('http-status')?.[0]);
      const fallback = { 3: 400, 5: 404, 7: 403, 8: 429, 10: 409, 14: 503, 16: 401, 4: 504 };
      reject(new AppError(explicit || fallback[error.code] || 500, error.details || 'Service unavailable', String(error.metadata?.get('business-code')?.[0] || '')));
    });
  });
}
export async function startGrpc(name, serviceName, handlers, health, port = process.env.GRPC_PORT || 50051) {
  if (!process.env.INTERNAL_KEY) throw new Error('INTERNAL_KEY is required');
  const server = new grpc.Server();
  const all = { ...handlers, Health: async () => { await health(); return { status: 'UP', service: name, message: 'ready' }; } };
  const implementation = Object.fromEntries(Object.entries(all).map(([method, handler]) => [method, (call, callback) => {
    Promise.resolve().then(() => {
      if (call.metadata.get('x-internal-key')[0] !== process.env.INTERNAL_KEY) throw new AppError(401, 'Invalid internal credentials');
      const uid = Number(call.metadata.get('x-user-id')[0]);
      const role = String(call.metadata.get('x-user-role')[0] || '');
      const actor = uid && role ? { uid, role } : null;
      return handler(call.request, actor, call);
    }).then(result => callback(null, result)).catch(error => {
      const status = error.status || 500;
      if (status >= 500) console.error(JSON.stringify({ service: name, method, error: error.message }));
      const metadata = new grpc.Metadata();
      metadata.set('http-status', String(status));
      if (error.businessCode) metadata.set('business-code', error.businessCode);
      callback({ code: statusMap[status] || grpc.status.INTERNAL, details: status >= 500 ? (status === 503 ? 'Service unavailable' : status === 504 ? 'Service timed out' : 'Internal server error') : error.message, metadata });
    });
  }]));
  server.addService(loadProto(name)[serviceName].service, implementation);
  await new Promise((resolve, reject) => server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), error => error ? reject(error) : resolve()));
  console.log(JSON.stringify({ service: name, grpcPort: Number(port), status: 'listening' }));
  return server;
}
