import { fail } from '../../../../shared/errors.js';

export const ROLES = Object.freeze({ CUSTOMER: 1, ADMIN: 2, SHIPMENT_STAFF: 3 });

export function validateRegistration(input) {
  if (typeof input.username !== 'string') fail(400, 'Username is required');
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,50}$/.test(username)) fail(400, 'Username must contain 3-50 letters, digits, dots, underscores or hyphens');
  validatePassword(input.password);
  if (input.email != null && typeof input.email !== 'string') fail(400, 'Email must be a string');
  if (input.phone != null && typeof input.phone !== 'string') fail(400, 'Phone must be a string');
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const phone = typeof input.phone === 'string' ? input.phone.trim() : '';
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) fail(400, 'Email is invalid');
  if (phone && !/^\+?[0-9]{8,15}$/.test(phone)) fail(400, 'Phone must contain 8-15 digits with an optional leading +');
  return { username, password: input.password, email: email || null, phone: phone || null };
}

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 6 || Buffer.byteLength(password, 'utf8') > 72) {
    fail(400, 'Password must contain at least 6 characters and at most 72 UTF-8 bytes');
  }
}

export function validateLogin(input) {
  if (typeof input.username !== 'string' || !input.username.trim() || typeof input.password !== 'string' || !input.password) {
    fail(400, 'Username and password are required');
  }
  if (input.username.length > 50 || Buffer.byteLength(input.password, 'utf8') > 72) fail(401, 'Invalid username or password');
  return { username: input.username.trim().toLowerCase(), password: input.password };
}
