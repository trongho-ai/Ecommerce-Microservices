export class AppError extends Error {
  constructor(status, message, businessCode = '') {
    super(message);
    this.status = status;
    this.businessCode = businessCode;
  }
}
export function fail(status, message, businessCode = '') { throw new AppError(status, message, businessCode); }
export function requireActor(actor, roles = []) {
  if (!actor?.uid || !actor?.role) fail(401, 'Authentication required');
  if (roles.length && !roles.includes(actor.role)) fail(403, 'Forbidden');
  return actor;
}
export function requireOwner(actor, uid) {
  requireActor(actor);
  if (actor.role !== 'ADMIN' && actor.uid !== Number(uid)) fail(403, 'Forbidden');
}
export function positiveId(value, name = 'id') {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) fail(400, `${name} must be a positive integer`);
  return value;
}
