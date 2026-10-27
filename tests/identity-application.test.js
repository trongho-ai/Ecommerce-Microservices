import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { authApplication } from '../services/auth-service/src/application/auth.js';

// Isolated application tests. Integration tests separately verify PostgreSQL and gRPC.
function fixture() {
  let stored;
  let job;
  let provisioningAvailable = false;
  const repository = {
    async create(user, passwordHash) {
      stored = { uid: 7, username: user.username, password: passwordHash, role: 'CUSTOMER' };
      job = { uid: 7, fullname: user.username, state: 'PENDING' };
      return stored;
    },
    async findByUsername(username) { return stored?.username === username ? stored : null; },
    async findIdentity(uid) { return stored?.uid === uid ? { uid, role: stored.role } : null; },
    async findProvisioning() { return job; },
    async provisioned() { job.state = 'DONE'; },
    async provisioningFailed() {},
    async pendingProvisioning() { return job?.state === 'PENDING' ? [job] : []; },
  };
  const secret = 'test-secret-for-identity-unit-tests-at-least-32-characters';
  const application = authApplication(repository, async () => {
    if (!provisioningAvailable) throw new Error('Customer temporarily unavailable');
  }, { jwtSecret: secret });
  return { application, secret, available: () => { provisioningAvailable = true; }, getStored: () => stored, getJob: () => job };
}

test('account creation survives Customer outage, but login waits for profile provisioning', async () => {
  const { application, available, getStored, getJob } = fixture();
  const registered = await application.register({ username: 'student', password: 'P@ss123' });
  assert.equal(registered.uid, 7);
  assert.match(registered.message, /provisioning pending/);
  assert.match(getStored().password, /^\$2[aby]\$/);
  assert.notEqual(getStored().password, 'P@ss123');
  assert.equal(getJob().state, 'PENDING');
  await assert.rejects(application.login({ username: 'student', password: 'P@ss123' }), error => error.status === 503);
  available();
  await application.retryProvisioning();
  assert.equal(getJob().state, 'DONE');
  const login = await application.login({ username: 'student', password: 'P@ss123' });
  const identity = await application.verifyToken({ token: login.accessToken });
  assert.equal(identity.uid, 7);
  assert.equal(identity.role, 'CUSTOMER');
  assert.equal(login.expiresIn, 3600);
});

test('Auth rejects wrong passwords, expired tokens and JWTs signed for another audience', async () => {
  const { application, available, secret } = fixture();
  available();
  await application.register({ username: 'student', password: 'P@ss123' });
  await assert.rejects(application.login({ username: 'student', password: 'wrong-password' }), error => error.status === 401);
  const expired = jwt.sign({ role: 'CUSTOMER', exp: Math.floor(Date.now() / 1000) - 1 }, secret, {
    subject: '7', issuer: 'ecommerce-auth', audience: 'ecommerce-api', algorithm: 'HS256',
  });
  await assert.rejects(application.verifyToken({ token: expired }), error => error.status === 401);
  const wrongAudience = jwt.sign({ role: 'CUSTOMER' }, secret, { subject: '7', issuer: 'ecommerce-auth', audience: 'other-service', expiresIn: 3600 });
  await assert.rejects(application.verifyToken({ token: wrongAudience }), error => error.status === 401);
  const missingExpiry = jwt.sign({ role: 'CUSTOMER' }, secret, { subject: '7', issuer: 'ecommerce-auth', audience: 'ecommerce-api' });
  await assert.rejects(application.verifyToken({ token: missingExpiry }), error => error.status === 401);
});
