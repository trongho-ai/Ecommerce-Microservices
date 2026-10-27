import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRegistration, validateLogin } from '../services/auth-service/src/domain/user.js';
import { validateCustomerUpdate, validateProvisioning } from '../services/customer-service/src/domain/customer.js';

test('registration normalizes optional account fields and rejects empty passwords', () => {
  assert.deepEqual(validateRegistration({ username: ' Student_1 ', password: 'P@ss123', email: ' A@Example.com ' }), {
    username: 'student_1', password: 'P@ss123', email: 'a@example.com', phone: null,
  });
  assert.throws(() => validateRegistration({ username: 'student', password: '' }), error => error.status === 400);
});

test('bcrypt password limit is measured in UTF-8 bytes, not JS characters', () => {
  assert.throws(() => validateRegistration({ username: 'student', password: 'ắ'.repeat(25) }), error => error.status === 400);
  assert.equal(validateRegistration({ username: 'student', password: 'a'.repeat(72) }).password.length, 72);
});

test('email and phone are optional, but malformed values are rejected', () => {
  assert.equal(validateRegistration({ username: 'student', password: 'P@ss123' }).email, null);
  assert.throws(() => validateRegistration({ username: 'student', password: 'P@ss123', email: 'not-an-email' }), error => error.status === 400);
  assert.throws(() => validateRegistration({ username: 'student', password: 'P@ss123', phone: 'text' }), error => error.status === 400);
  assert.throws(() => validateLogin({ username: 'student', password: '' }), error => error.status === 400);
});

test('Customer owner can edit fullname but cannot change Membership', () => {
  const actor = { uid: 7, role: 'CUSTOMER' };
  assert.deepEqual(validateCustomerUpdate({ uid: 7, fullname: ' New Name ' }, actor), { uid: 7, fullname: 'New Name' });
  assert.throws(() => validateCustomerUpdate({ uid: 7, mid: 3 }, actor), error => error.status === 403);
  assert.throws(() => validateCustomerUpdate({ uid: 8, fullname: 'Other' }, actor), error => error.status === 403);
  assert.deepEqual(validateCustomerUpdate({ uid: 7, mid: 3 }, { uid: 1, role: 'ADMIN' }), { uid: 7, mid: 3 });
});

test('Customer provisioning enforces valid uid and fullname', () => {
  assert.deepEqual(validateProvisioning({ uid: 7, fullname: ' Student ' }), { uid: 7, fullname: 'Student' });
  assert.throws(() => validateProvisioning({ uid: 0, fullname: 'Student' }), error => error.status === 400);
  assert.throws(() => validateProvisioning({ uid: 7, fullname: '' }), error => error.status === 400);
});
