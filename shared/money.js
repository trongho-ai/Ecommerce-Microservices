import { fail } from './errors.js';
export function toMinor(value) {
  const text = String(value);
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(text)) fail(400, 'Money must be non-negative with at most 2 decimal places');
  const [whole, fraction = ''] = text.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result > 9999999999) fail(400, 'Money is out of range');
  return result;
}
export function fromMinor(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 9999999999) fail(400, 'Money total is out of range');
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, '0')}`;
}
