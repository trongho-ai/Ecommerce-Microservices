import { fail, positiveId, requireOwner } from '../../../../shared/errors.js';

export function validateCustomerUpdate(input, actor) {
  positiveId(input.uid, 'uid');
  requireOwner(actor, input.uid);
  const hasFullname = Object.hasOwn(input, 'fullname');
  const hasMid = Object.hasOwn(input, 'mid');
  if (!hasFullname && !hasMid) fail(400, 'At least fullname or mid is required');
  const result = { uid: input.uid };
  if (hasFullname) {
    if (typeof input.fullname !== 'string' || !input.fullname.trim() || input.fullname.trim().length > 100) fail(400, 'Fullname must contain 1-100 characters');
    result.fullname = input.fullname.trim();
  }
  if (hasMid) {
    if (actor.role !== 'ADMIN') fail(403, 'Only Admin can change membership');
    result.mid = positiveId(input.mid, 'mid');
  }
  return result;
}

export function validateProvisioning(input) {
  const uid = positiveId(input.uid, 'uid');
  if (typeof input.fullname !== 'string' || !input.fullname.trim() || input.fullname.trim().length > 100) fail(400, 'Fullname must contain 1-100 characters');
  return { uid, fullname: input.fullname.trim() };
}
