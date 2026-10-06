// ── User administration service (FR-3.x) ─────────────────────────────────
import { AppError, badRequest, conflict, notFound, weakPassword } from '../core/errors.js';
import { hashPassword, verifyPassword, passwordPolicyProblems } from '../core/passwords.js';
import { generateUsername, nextInstructorCode, nextStudentId } from '../core/ids.js';
import { nowIso, reqEmail, reqString, reqLevel } from '../core/validate.js';

export class UserService {
  constructor(db) { this.db = db; }

  _assertPassword(pw) {
    const problems = passwordPolicyProblems(pw);
    if (problems.length) throw weakPassword(problems);
  }

  _byId(id) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw notFound('Account not found.');
    return u;
  }

  publicUser(u) {
    return {
      id: u.id, role: u.role, full_name: u.full_name, username: u.username,
      email: u.email, is_active: !!u.is_active,
      instructor_code: u.instructor_code ?? null,
      student_id: u.student_id ?? null,
      academic_level: u.academic_level ?? null,
      created_at: u.created_at,
    };
  }

  stats() {
    const one = (sql, ...p) => Number(this.db.prepare(sql).get(...p ?? []).c ?? 0);
    return {
      teachers: one(`SELECT COUNT(*) c FROM users WHERE role='teacher'`),
      students: one(`SELECT COUNT(*) c FROM users WHERE role='student'`),
      courses: one(`SELECT COUNT(*) c FROM courses`),
      activeAccounts: one(`SELECT COUNT(*) c FROM users WHERE is_active=1`),
      inactiveAccounts: one(`SELECT COUNT(*) c FROM users WHERE is_active=0`),
      materials: one(`SELECT COUNT(*) c FROM materials`),
      quizzes: one(`SELECT COUNT(*) c FROM quizzes`),
      pendingGrading: one(`SELECT COUNT(*) c FROM attempts WHERE status IN ('submitted')`),
      backups: one(`SELECT COUNT(*) c FROM backups`),
    };
  }

  /** Most recent sign-ins (sessions carry ip + timestamps). */
  recentSignins(limit = 30) {
    return this.db.prepare(`
      SELECT s.created_at, s.last_seen_at, s.ip,
             u.full_name, u.username, u.role, u.is_active
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC
      LIMIT ?
    `).all(Math.min(limit, 100));
  }

  /** FR-3.3 — searchable role lists with teacher course counts. */
  list({ role, q, status }) {
    const where = [];
    const params = [];
    if (role && ['admin', 'teacher', 'student'].includes(role)) { where.push('role = ?'); params.push(role); }
    if (status === 'active') where.push('is_active = 1');
    if (status === 'inactive') where.push('is_active = 0');
    if (q) {
      where.push('(full_name LIKE ? OR username LIKE ? OR email LIKE ? OR COALESCE(instructor_code,\'\') LIKE ? OR COALESCE(student_id,\'\') LIKE ?)');
      const like = `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like, like, like, like);
    }
    const rows = this.db.prepare(`
      SELECT u.*, (SELECT COUNT(*) FROM courses c WHERE c.teacher_id = u.id) AS course_count
      FROM users u
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY u.role, u.full_name
      LIMIT 1000
    `).all(...params);
    return rows.map((r) => ({ ...this.publicUser(r), course_count: r.course_count }));
  }

  /** FR-3.1 — provision a teacher. */
  createTeacher({ full_name, email, instructor_code, password }) {
    const name = reqString(full_name, 'full name', { min: 3, max: 120 });
    const mail = reqEmail(email);
    this._assertPassword(password);
    let code = typeof instructor_code === 'string' && instructor_code.trim()
      ? reqString(instructor_code, 'instructor code', { min: 3, max: 20 }).toUpperCase()
      : null;

    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(mail)) {
        throw conflict('That email address is already used by another account.');
      }
      if (code && this.db.prepare('SELECT 1 FROM users WHERE instructor_code = ?').get(code)) {
        throw conflict(`Instructor code ${code} is already assigned.`);
      }
      if (!code) code = nextInstructorCode(this.db);
      const username = generateUsername(this.db, name);
      const now = nowIso();
      const { lastId } = this.db.prepare(`
        INSERT INTO users (role, full_name, username, email, password_hash, instructor_code, created_at, updated_at)
        VALUES ('teacher', ?, ?, ?, ?, ?, ?, ?)
      `).run(name, username, mail, hashPassword(password), code, now, now);
      return this.publicUser(this._byId(lastId));
    });
  }

  /** FR-3.2 — register a student. */
  createStudent({ full_name, email, academic_level, password }) {
    const name = reqString(full_name, 'full name', { min: 3, max: 120 });
    const mail = reqEmail(email);
    const level = reqLevel(academic_level);
    this._assertPassword(password);

    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(mail)) {
        throw conflict('That email address is already used by another account.');
      }
      const sid = nextStudentId(this.db);
      const username = generateUsername(this.db, name);
      const now = nowIso();
      const { lastId } = this.db.prepare(`
        INSERT INTO users (role, full_name, username, email, password_hash, student_id, academic_level, created_at, updated_at)
        VALUES ('student', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, username, mail, hashPassword(password), sid, level, now, now);
      return this.publicUser(this._byId(lastId));
    });
  }

  /** FR-3.4 / FR-3.5 — edit identity/role fields and activation. */
  update(id, patch) {
    const user = this._byId(id);
    const fields = {};
    if (patch.full_name !== undefined) fields.full_name = reqString(patch.full_name, 'full name', { min: 3, max: 120 });
    if (patch.username !== undefined) fields.username = reqString(patch.username, 'username', { min: 3, max: 60 });
    if (patch.email !== undefined) fields.email = reqEmail(patch.email);
    if (patch.is_active !== undefined) fields.is_active = patch.is_active ? 1 : 0;
    if (user.role === 'teacher' && patch.instructor_code !== undefined) {
      const code = reqString(patch.instructor_code, 'instructor code', { min: 3, max: 20 }).toUpperCase();
      const dupe = this.db.prepare('SELECT id FROM users WHERE instructor_code = ? AND id != ?').get(code, id);
      if (dupe) throw conflict(`Instructor code ${code} is already assigned.`);
      fields.instructor_code = code;
    }
    if (user.role === 'student') {
      if (patch.student_id !== undefined) {
        const sid = reqString(patch.student_id, 'student ID', { min: 3, max: 30 }).toUpperCase();
        const dupe = this.db.prepare('SELECT id FROM users WHERE student_id = ? AND id != ?').get(sid, id);
        if (dupe) throw conflict(`Student ID ${sid} is already assigned.`);
        fields.student_id = sid;
      }
      if (patch.academic_level !== undefined) fields.academic_level = reqLevel(patch.academic_level);
    }
    if (!Object.keys(fields).length) throw badRequest('Nothing to update.');

    return this.db.transaction(() => {
      if (fields.username) {
        const dupe = this.db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(fields.username, id);
        if (dupe) throw conflict('That username is already taken.');
      }
      if (fields.email) {
        const dupe = this.db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(fields.email, id);
        if (dupe) throw conflict('That email address is already used by another account.');
      }
      fields.updated_at = nowIso();
      const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
      this.db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...Object.values(fields), id);
      return this.publicUser(this._byId(id));
    });
  }

  /** FR-3.6 — admin password reset, policy enforced. */
  resetPassword(id, password) {
    this._byId(id);
    this._assertPassword(password);
    this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashPassword(password), nowIso(), id);
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // revoke live sessions
    return { ok: true };
  }

  /** Self-service password change (all roles). */
  changePassword(user, current, next) {
    const row = this._byId(user.id);
    if (!verifyPassword(current, row.password_hash)) throw badRequest('Your current password is incorrect.');
    this._assertPassword(next);
    this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashPassword(next), nowIso(), user.id);
    return { ok: true };
  }

  /** FR-3.7 — guarded permanent delete. */
  delete(id) {
    const user = this._byId(id);
    if (user.role === 'admin') {
      throw new AppError(403, 'forbidden',
        'An administrator account can never be deleted from this screen.');
    }
    if (user.role === 'teacher') {
      const owned = this.db.prepare('SELECT COUNT(*) c FROM courses WHERE teacher_id = ?').get(id).c;
      if (owned > 0) {
        throw conflict(
          `This teacher still owns ${owned} course${owned > 1 ? 's' : ''}. ` +
          'Delete or reassign the course(s) first, or deactivate the account instead — ' +
          'course content and recorded grades are never silently destroyed.');
      }
    }
    // students: attempts/progress cascade; sessions cascade.
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { ok: true };
  }
}
