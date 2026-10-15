// ── Auth routes (FR-1.x) ─────────────────────────────────────────────────
import { unauthorized, forbidden, badRequest } from '../core/errors.js';
import { verifyPassword, hashPassword } from '../core/passwords.js';
import { getHeader } from '../core/validate.js';

export function registerAuthRoutes(router, ctx) {
  const { db, sessions, services, config, limiter } = ctx;

  router.post('/api/auth/login', async (req, res, { body, ip }) => {
    const { role, identifier, password } = body ?? {};
    if (!['student', 'teacher', 'admin'].includes(role)) {
      throw badRequest('Select your portal role before signing in.');
    }
    const ident = String(identifier ?? '').trim().toLowerCase();
    if (!limiter.check(`login:${ip}:${ident}`)) {
      throw unauthorized('Too many sign-in attempts. Please wait a minute and try again.');
    }
    // Students sign in with their Student ID (also accepts username/email);
    // teachers/admins use username or email. Student IDs are case-insensitive.
    const user = await db.prepare(
      `SELECT * FROM users WHERE (username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE
        OR student_id = ? COLLATE NOCASE) LIMIT 1`
    ).get(ident, ident, ident.toUpperCase());

    const ok = user && verifyPassword(String(password ?? ''), user.password_hash);
    if (!ok || user.role !== role) {
      throw unauthorized('Invalid credentials — check your Student ID/username, password, and selected role.');
    }
    if (!user.is_active) {
      throw forbidden('This account has been deactivated. Please contact the administrator.');
    }
    // Transparent upgrade: legacy s1-tier hashes get rehashed to the fast
    // s2 tier on successful login, so every account migrates to the
    // low-CPU verification cost without anyone resetting passwords.
    if (String(user.password_hash).startsWith('s1$')) {
      try {
        await db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
          .run(hashPassword(String(password ?? '')), new Date().toISOString(), user.id);
      } catch { /* upgrade is best-effort — never block a valid login */ }
    }
    const token = await sessions.create(user.id, ip, getHeader(req, 'user-agent'));
    ctx.setSessionCookie(res, token);
    return { user: services.users.publicUser(user) };
  });

  router.post('/api/auth/logout', async (req, res, { token }) => {
    if (token) await sessions.destroy(token);
    ctx.clearSessionCookie(res);
    return { ok: true };
  });

  router.get('/api/auth/me', async (req, res, { user }) => {
    if (!user) throw unauthorized();
    return { user };
  });

  router.post('/api/auth/change-password', async (req, res, { user, body }) => {
    if (!user) throw unauthorized();
    return await services.users.changePassword(user, body?.current, body?.next);
  });
}
