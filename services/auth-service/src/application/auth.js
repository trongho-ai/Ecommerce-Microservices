import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { fail } from '../../../../shared/errors.js';
import { validateLogin, validateRegistration } from '../domain/user.js';

export function authApplication(repository, ensureCustomer, options) {
  const { jwtSecret, jwtTtl = 3600 } = options;
  if (!jwtSecret || jwtSecret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
  if (!Number.isInteger(jwtTtl) || jwtTtl < 1 || jwtTtl > 86400) throw new Error('JWT_TTL_SECONDS must be an integer between 1 and 86400');

  async function provision(job) {
    if (!job || job.state === 'DONE') return;
    try {
      await ensureCustomer({ uid: job.uid, fullname: job.fullname });
      await repository.provisioned(job.uid);
    } catch (error) {
      await repository.provisioningFailed(job.uid, error);
      throw error;
    }
  }

  return {
    async register(input) {
      const user = validateRegistration(input);
      const created = await repository.create(user, await bcrypt.hash(user.password, 10));
      let provisionPending = false;
      try { await provision({ uid: created.uid, fullname: user.username, state: 'PENDING' }); }
      catch { provisionPending = true; }
      return {
        uid: created.uid,
        message: provisionPending ? 'User registered; customer profile provisioning pending. Retry login shortly.' : 'User registered successfully',
      };
    },
    async login(input) {
      const credentials = validateLogin(input);
      const user = await repository.findByUsername(credentials.username);
      if (!user || !(await bcrypt.compare(credentials.password, user.password))) fail(401, 'Invalid username or password');
      try { await provision(await repository.findProvisioning(user.uid)); }
      catch { fail(503, 'Customer profile is not ready; retry login shortly'); }
      const accessToken = jwt.sign({ role: user.role }, jwtSecret, {
        algorithm: 'HS256', subject: String(user.uid), expiresIn: jwtTtl,
        issuer: 'ecommerce-auth', audience: 'ecommerce-api',
      });
      return { accessToken, tokenType: 'Bearer', expiresIn: jwtTtl };
    },
    async verifyToken(input) {
      let payload;
      try {
        payload = jwt.verify(input.token, jwtSecret, { algorithms: ['HS256'], issuer: 'ecommerce-auth', audience: 'ecommerce-api' });
      } catch { fail(401, 'Invalid or expired token'); }
      const uid = Number(payload.sub);
      if (!Number.isInteger(uid) || uid < 1 || uid > 2147483647 || !['CUSTOMER', 'ADMIN', 'SHIPMENT_STAFF'].includes(payload.role)
        || !Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) fail(401, 'Invalid token claims');
      const identity = await repository.findIdentity(uid);
      if (!identity || identity.role !== payload.role) fail(401, 'Invalid token identity');
      return { uid, role: payload.role, exp: payload.exp };
    },
    async retryProvisioning() {
      for (const job of await repository.pendingProvisioning()) {
        try { await provision(job); }
        catch { console.error(JSON.stringify({ service: 'auth', operation: 'provisionCustomer', uid: job.uid, status: 'retry_pending' })); }
      }
    },
  };
}
