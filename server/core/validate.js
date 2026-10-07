// ── Input validation helpers ─────────────────────────────────────────────
import { badRequest } from './errors.js';
import { LEVELS } from '../config.js';

export const nowIso = () => new Date().toISOString();

/** Reads a header regardless of whether `req` is a Node IncomingMessage
 *  (plain headers object) or a Fetch API Request (Headers, via .get()). */
export const getHeader = (req, name) =>
  typeof req.headers?.get === 'function' ? req.headers.get(name) : req.headers?.[name];

export function reqString(value, field, { min = 1, max = 300 } = {}) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (v.length < min) throw badRequest(`"${field}" is required.`);
  if (v.length > max) throw badRequest(`"${field}" must be at most ${max} characters.`);
  return v;
}

export function optString(value, { max = 5000 } = {}) {
  const v = typeof value === 'string' ? value.trim() : '';
  return v.slice(0, max);
}

export function reqEmail(value, field = 'email') {
  const v = reqString(value, field, { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) throw badRequest(`"${field}" must be a valid email address.`);
  return v;
}

export function reqLevel(value, field = 'academic level') {
  if (!LEVELS.includes(value)) {
    throw badRequest(`"${field}" must be one of: ${LEVELS.join(', ')}.`);
  }
  return value;
}

export function reqInt(value, field, { min = 0, max = 10000, nullable = false } = {}) {
  if (value == null && nullable) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`"${field}" must be a whole number between ${min} and ${max}.`);
  }
  return n;
}

/** ISO datetime or null; rejects garbage. */
export function optIsoDate(value, field) {
  if (value == null || value === '') return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw badRequest(`"${field}" must be a valid date-time.`);
  return new Date(t).toISOString();
}
