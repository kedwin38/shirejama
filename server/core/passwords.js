// ── Password hashing (scrypt) + institutional password policy (FR-1.6) ──
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `s1$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [tag, saltHex, keyHex] = String(stored).split('$');
    if (tag !== 's1' || !saltHex || !keyHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    const actual = scryptSync(password, salt, expected.length, SCRYPT);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Returns array of human-readable policy failures ([] = compliant). */
export function passwordPolicyProblems(password) {
  const pw = String(password ?? '');
  const problems = [];
  if (pw.length < 8) problems.push('at least 8 characters long');
  if (!/[a-z]/.test(pw)) problems.push('one lowercase letter');
  if (!/[A-Z]/.test(pw)) problems.push('one uppercase letter');
  if (!/[0-9]/.test(pw)) problems.push('one digit');
  return problems;
}
