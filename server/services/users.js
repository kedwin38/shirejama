// ── User administration service (FR-3.x) ─────────────────────────────────
// Students have NO email: they are identified by their Student ID (plus an
// internal username). Teachers/admins still require an email address.
import { AppError, badRequest, conflict, notFound, weakPassword } from '../core/errors.js';
import { hashPassword, verifyPassword, passwordPolicyProblems } from '../core/passwords.js';
import { generateUsername, nextInstructorCode, nextStudentId, usernameBase, allocateUsername } from '../core/ids.js';
import { nowIso, reqEmail, reqString, reqLevel } from '../core/validate.js';

const cleanStudentId = (v) => String(v ?? '').trim().toUpperCase().replace(/\s+/g, '');
const validStudentId = (sid) => sid.length >= 3 && sid.length <= 40 && !sid.includes('@');

export class UserService {
  constructor(db) { this.db = db; }

  _assertPassword(pw) {
    const problems = passwordPolicyProblems(pw);
    if (problems.length) throw weakPassword(problems);
  }

  async _byId(id) {
    const u = await this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw notFound('Account not found.');
    return u;
  }

  publicUser(u) {
    return {
      id: u.id, role: u.role, full_name: u.full_name, username: u.username,
      email: u.email ?? null, is_active: !!u.is_active,
      instructor_code: u.instructor_code ?? null,
      student_id: u.student_id ?? null,
      academic_level: u.academic_level ?? null,
      created_at: u.created_at,
    };
  }

  async stats() {
    const one = async (sql, ...p) => Number((await this.db.prepare(sql).get(...p)).c ?? 0);
    return {
      teachers: await one(`SELECT COUNT(*) c FROM users WHERE role='teacher'`),
      students: await one(`SELECT COUNT(*) c FROM users WHERE role='student'`),
      courses: await one(`SELECT COUNT(*) c FROM courses`),
      activeAccounts: await one(`SELECT COUNT(*) c FROM users WHERE is_active=1`),
      inactiveAccounts: await one(`SELECT COUNT(*) c FROM users WHERE is_active=0`),
      materials: await one(`SELECT COUNT(*) c FROM materials`),
      quizzes: await one(`SELECT COUNT(*) c FROM quizzes`),
      pendingGrading: await one(`SELECT COUNT(*) c FROM attempts WHERE status IN ('submitted')`),
      backups: await one(`SELECT COUNT(*) c FROM backups`),
    };
  }

  /** Most recent sign-ins (sessions carry ip + timestamps). */
  async recentSignins(limit = 30) {
    return await this.db.prepare(`
      SELECT s.created_at, s.last_seen_at, s.ip,
             u.full_name, u.username, u.role, u.is_active
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC
      LIMIT ?
    `).all(Math.min(limit, 100));
  }

  /** FR-3.3 — searchable role lists with teacher course counts. */
  async list({ role, q, status }) {
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
    const rows = await this.db.prepare(`
      SELECT u.*, (SELECT COUNT(*) FROM courses c WHERE c.teacher_id = u.id) AS course_count
      FROM users u
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY u.role, u.full_name
      LIMIT 1000
    `).all(...params);
    const out = [];
    for (const r of rows) out.push({ ...this.publicUser(r), course_count: r.course_count });
    return out;
  }

  /** FR-3.1 — provision a teacher. */
  async createTeacher({ full_name, email, instructor_code, password }) {
    const name = reqString(full_name, 'full name', { min: 3, max: 120 });
    const mail = reqEmail(email);
    this._assertPassword(password);
    let code = typeof instructor_code === 'string' && instructor_code.trim()
      ? reqString(instructor_code, 'instructor code', { min: 3, max: 20 }).toUpperCase()
      : null;

    return await this.db.transaction(async () => {
      if (await this.db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(mail)) {
        throw conflict('That email address is already used by another account.');
      }
      if (code && await this.db.prepare('SELECT 1 FROM users WHERE instructor_code = ?').get(code)) {
        throw conflict(`Instructor code ${code} is already assigned.`);
      }
      if (!code) code = await nextInstructorCode(this.db);
      const username = await generateUsername(this.db, name);
      const now = nowIso();
      const { lastId } = await this.db.prepare(`
        INSERT INTO users (role, full_name, username, email, password_hash, instructor_code, created_at, updated_at)
        VALUES ('teacher', ?, ?, ?, ?, ?, ?, ?)
      `).run(name, username, mail, hashPassword(password), code, now, now);
      return this.publicUser(await this._byId(lastId));
    });
  }

  /** FR-3.2 — register a student (no email; Student ID is the identity). */
  async createStudent({ full_name, student_id, academic_level, password }) {
    const name = reqString(full_name, 'full name', { min: 3, max: 120 });
    const level = reqLevel(academic_level);
    this._assertPassword(password);
    let givenSid = typeof student_id === 'string' ? cleanStudentId(student_id) : '';
    if (givenSid && !validStudentId(givenSid)) {
      throw badRequest('Student ID must be 3–40 letters/digits/hyphens.');
    }

    return await this.db.transaction(async () => {
      let sid;
      if (givenSid) {
        if (await this.db.prepare('SELECT 1 FROM users WHERE student_id = ?').get(givenSid)) {
          throw conflict(`A student account already exists with ID ${givenSid}.`);
        }
        sid = givenSid;
      } else {
        sid = await nextStudentId(this.db);
      }
      const username = await generateUsername(this.db, name);
      const now = nowIso();
      const { lastId } = await this.db.prepare(`
        INSERT INTO users (role, full_name, username, email, password_hash, student_id, academic_level, created_at, updated_at)
        VALUES ('student', ?, ?, NULL, ?, ?, ?, ?, ?)
      `).run(name, username, hashPassword(password), sid, level, now, now);
      return this.publicUser(await this._byId(lastId));
    });
  }

  /**
   * Bulk provision — CSV/XLSX upload of {name, student_id} rows for ONE
   * academic level with one shared default password (policy-checked).
   * Students receive NO email; usernames derive from the name. Rows whose
   * Student ID already has an account are SKIPPED and reported back, so a
   * re-uploaded list only creates the missing accounts.
   *
   * Engineered for large files: O(1) database round trips per request
   * (set-based duplicate check + one batched INSERT) and the shared password
   * is hashed ONCE — 100 rows cost roughly one scrypt, not 100, so a batch
   * can never blow the Worker CPU/wall budget mid-run the way per-row loops
   * did. Capped per request; the UI queues larger files in slices.
   */
  async bulkProvisionStudents({ academic_level, password, rows }) {
    const level = reqLevel(academic_level);
    this._assertPassword(password);
    if (!Array.isArray(rows) || rows.length === 0) throw badRequest('Provide at least one student row.');
    if (rows.length > 150) throw badRequest('Bulk provision accepts up to 150 students per request — larger files are batched automatically.');

    // 1 · validate + clean every row in memory; dedupe within the file
    const valid = [], skipped = [], invalid = [];
    const seenIds = new Set();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] ?? {};
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      const sid = typeof row.student_id === 'string' ? cleanStudentId(row.student_id) : '';
      if (name.length < 3 || name.length > 120) {
        invalid.push({ row: i + 1, name, student_id: sid, reason: 'Name must be 3–120 characters.' });
        continue;
      }
      if (!validStudentId(sid)) {
        invalid.push({ row: i + 1, name, student_id: sid, reason: 'Student ID must be 3–40 letters/digits/hyphens.' });
        continue;
      }
      if (seenIds.has(sid)) {
        skipped.push({ student_id: sid, name, reason: 'Duplicate Student ID in this file — only the first row was used.' });
        continue;
      }
      seenIds.add(sid);
      valid.push({ name, student_id: sid });
    }

    // 2 · set-based existence check — one query per ≤100 IDs
    const existing = new Set();
    for (let i = 0; i < valid.length; i += 100) {
      const chunk = valid.slice(i, i + 100);
      const ph = chunk.map(() => '?').join(',');
      const found = await this.db.prepare(`SELECT student_id FROM users WHERE student_id IN (${ph})`)
        .all(...chunk.map((r) => r.student_id));
      for (const r of found) existing.add(r.student_id);
    }
    const toCreate = [];
    for (const r of valid) {
      if (existing.has(r.student_id)) {
        skipped.push({ student_id: r.student_id, name: r.name, reason: 'An account already exists with this Student ID — skipped.' });
      } else toCreate.push(r);
    }

    // 3 · usernames allocated in memory against a preloaded collision set
    const takenLc = new Set();
    const bases = [...new Set(toCreate.map((r) => usernameBase(r.name)))];
    for (let i = 0; i < bases.length; i += 40) {
      const chunk = bases.slice(i, i + 40);
      const where = chunk.map(() => 'username LIKE ? COLLATE NOCASE').join(' OR ');
      const found = await this.db.prepare(`SELECT username FROM users WHERE ${where}`)
        .all(...chunk.map((b) => `${b}%`));
      for (const r of found) takenLc.add(r.username.toLowerCase());
    }

    // 4 · the shared default password is hashed ONCE (scrypt is expensive —
    //    hashing per row was the mid-batch timeout killer on Workers)
    const hash = hashPassword(password);
    const now = nowIso();
    const created = [];
    const stmts = toCreate.map((r) => {
      const username = allocateUsername(usernameBase(r.name), takenLc);
      takenLc.add(username.toLowerCase());
      created.push({ name: r.name, student_id: r.student_id, username });
      return {
        sql: `INSERT INTO users (role, full_name, username, email, password_hash, is_active, student_id, academic_level, created_at, updated_at)
              VALUES ('student', ?, ?, NULL, ?, 1, ?, ?, ?, ?)`,
        params: [r.name, username, hash, r.student_id, level, now, now],
      };
    });

    // 5 · one round trip (D1 batch) or one transaction (Node)
    if (stmts.length) {
      if (typeof this.db.batch === 'function') await this.db.batch(stmts);
      else await this.db.transaction(async () => {
        for (const s of stmts) await this.db.prepare(s.sql).run(...s.params);
      });
    }

    return {
      created_count: created.length, skipped_count: skipped.length, invalid_count: invalid.length,
      created, skipped, invalid,
    };
  }

  /** FR-3.4 / FR-3.5 — edit identity/role fields and activation. */
  async update(id, patch) {
    const user = await this._byId(id);
    const fields = {};
    if (patch.full_name !== undefined) fields.full_name = reqString(patch.full_name, 'full name', { min: 3, max: 120 });
    if (patch.username !== undefined) fields.username = reqString(patch.username, 'username', { min: 3, max: 60 });
    if (patch.email !== undefined) {
      // Students have no email (leave blank to clear); staff require one.
      const raw = typeof patch.email === 'string' ? patch.email.trim() : '';
      if (user.role === 'student' && !raw) fields.email = null;
      else fields.email = reqEmail(raw);
    }
    if (patch.is_active !== undefined) fields.is_active = patch.is_active ? 1 : 0;
    if (user.role === 'teacher' && patch.instructor_code !== undefined) {
      const code = reqString(patch.instructor_code, 'instructor code', { min: 3, max: 20 }).toUpperCase();
      const dupe = await this.db.prepare('SELECT id FROM users WHERE instructor_code = ? AND id != ?').get(code, id);
      if (dupe) throw conflict(`Instructor code ${code} is already assigned.`);
      fields.instructor_code = code;
    }
    if (user.role === 'student') {
      if (patch.student_id !== undefined) {
        const sid = cleanStudentId(patch.student_id);
        if (!validStudentId(sid)) throw badRequest('Student ID must be 3–40 letters/digits/hyphens.');
        const dupe = await this.db.prepare('SELECT id FROM users WHERE student_id = ? AND id != ?').get(sid, id);
        if (dupe) throw conflict(`Student ID ${sid} is already assigned.`);
        fields.student_id = sid;
      }
      if (patch.academic_level !== undefined) fields.academic_level = reqLevel(patch.academic_level);
    }
    if (!Object.keys(fields).length) throw badRequest('Nothing to update.');

    return await this.db.transaction(async () => {
      if (fields.username) {
        const dupe = await this.db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(fields.username, id);
        if (dupe) throw conflict('That username is already taken.');
      }
      if (fields.email) {
        const dupe = await this.db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(fields.email, id);
        if (dupe) throw conflict('That email address is already used by another account.');
      }
      fields.updated_at = nowIso();
      const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
      await this.db.prepare(`UPDATE users SET ${sets} WHERE id = ?`).run(...Object.values(fields), id);
      return this.publicUser(await this._byId(id));
    });
  }

  /** FR-3.6 — admin password reset, policy enforced. */
  async resetPassword(id, password) {
    await this._byId(id);
    this._assertPassword(password);
    await this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashPassword(password), nowIso(), id);
    await this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // revoke live sessions
    return { ok: true };
  }

  /** Self-service password change (all roles). */
  async changePassword(user, current, next) {
    const row = await this._byId(user.id);
    if (!verifyPassword(current, row.password_hash)) throw badRequest('Your current password is incorrect.');
    this._assertPassword(next);
    await this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashPassword(next), nowIso(), user.id);
    return { ok: true };
  }

  /** FR-3.7 — guarded permanent delete. */
  async delete(id) {
    const user = await this._byId(id);
    if (user.role === 'admin') {
      throw new AppError(403, 'forbidden',
        'An administrator account can never be deleted from this screen.');
    }
    if (user.role === 'teacher') {
      const owned = (await this.db.prepare('SELECT COUNT(*) c FROM courses WHERE teacher_id = ?').get(id)).c;
      if (owned > 0) {
        throw conflict(
          `This teacher still owns ${owned} course${owned > 1 ? 's' : ''}. ` +
          'Delete or reassign the course(s) first, or deactivate the account instead — ' +
          'course content and recorded grades are never silently destroyed.');
      }
    }
    // students: attempts/progress cascade; sessions cascade.
    await this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return { ok: true };
  }
}
