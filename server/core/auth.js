// ── Sessions: server-side, DB-backed (ADR-004) ───────────────────────────
import { randomBytes } from 'node:crypto';
import { unauthorized } from './errors.js';
import { nowIso } from './validate.js';

export class SessionStore {
  constructor(db, ttlHours) {
    this.db = db;
    this.ttlMs = ttlHours * 3600 * 1000;
    // opportunistic purge (runs at boot; cheap because of idx_sessions_exp)
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowIso());
  }

  create(userId, ip, userAgent) {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
      VALUES (?,?,?,?,?,?,?)
    `).run(token, userId, new Date(now).toISOString(),
           new Date(now + this.ttlMs).toISOString(),
           new Date(now).toISOString(), ip ?? null, (userAgent ?? '').slice(0, 300));
    return token;
  }

  /** Resolves an active, non-expired session for a live, active user. */
  resolve(token) {
    if (!token || typeof token !== 'string' || token.length > 128) return null;
    const row = this.db.prepare(`
      SELECT u.id, u.role, u.full_name, u.username, u.email, u.is_active,
             u.instructor_code, u.student_id, u.academic_level,
             s.token, s.expires_at, s.last_seen_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?
    `).get(token);
    if (!row) return null;
    if (Date.now() > Date.parse(row.expires_at)) {
      this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      return null;
    }
    if (!row.is_active) return null; // deactivated mid-session (FR-1.7)
    return {
      id: row.id, role: row.role, full_name: row.full_name,
      username: row.username, email: row.email,
      instructor_code: row.instructor_code, student_id: row.student_id,
      academic_level: row.academic_level,
    };
  }

  /** Sliding expiry; throttled to one write per 60 s per session. */
  touch(token) {
    if (!token) return;
    const row = this.db.prepare('SELECT last_seen_at FROM sessions WHERE token = ?').get(token);
    if (!row) return;
    if (Date.now() - Date.parse(row.last_seen_at) > 60_000) {
      const exp = new Date(Date.now() + this.ttlMs).toISOString();
      this.db.prepare('UPDATE sessions SET last_seen_at=?, expires_at=? WHERE token=?')
        .run(new Date().toISOString(), exp, token);
    }
  }

  destroy(token) {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  destroyAllForUser(userId) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

/** Route middleware factory: attaches ctx.user or throws 401/403. */
export const requireAuth = (...roles) => (ctx) => {
  if (!ctx.user) throw unauthorized();
  if (roles.length && !roles.includes(ctx.user.role)) {
    throw unauthorized('This portal is not available for your account role.');
  }
  return true;
};
