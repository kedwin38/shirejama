// ── Password hashing (scrypt) + institutional password policy (FR-1.6) ──
// Two cost tiers, chosen by tag:
//   s1$ — N=16384 (legacy; still verified, never minted)
//   s2$ — N=8192  (current) — halves login CPU on edge runtimes where the
//         free-tier CPU budget kills ~100ms verifications intermittently,
//         which users experienced as sign-in "timeouts".
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const TIERS = {
  s1: { N: 16384, r: 8, p: 1, keylen: 64 },
  s2: { N: 8192, r: 8, p: 1, keylen: 64 },
};
const MINT = 's2';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const t = TIERS[MINT];
  const key = scryptSync(password, salt, t.keylen, t);
  return `${MINT}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [tag, saltHex, keyHex] = String(stored).split('$');
    const t = TIERS[tag];
    if (!t || !saltHex || !keyHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(keyHex, 'hex');
    const actual = scryptSync(password, salt, expected.length, t);
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
