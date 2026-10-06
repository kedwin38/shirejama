// ── Student catalog + progress service (FR-5.1 / FR-5.4) ─────────────────
import { badRequest, forbidden, notFound } from '../core/errors.js';
import { nowIso } from '../core/validate.js';

export class CatalogService {
  constructor(db) { this.db = db; }

  /** FR-5.1 — every course whose levels include the student's level. */
  listForStudent(student) {
    const courses = this.db.prepare(`
      SELECT c.*, u.full_name AS teacher_name, u.instructor_code,
        (SELECT COUNT(*) FROM chapters h WHERE h.course_id = c.id) chapter_count,
        (SELECT COUNT(DISTINCT h.course_id) FROM progress p JOIN chapters h ON h.id = p.chapter_id
           WHERE h.course_id = c.id AND p.student_id = ?) AS done_chapters
      FROM courses c
      JOIN course_levels cl ON cl.course_id = c.id AND cl.level = ?
      JOIN users u ON u.id = c.teacher_id
      ORDER BY c.updated_at DESC
    `).all(student.id, student.academic_level);

    const lvlStmt = this.db.prepare(
      'SELECT level FROM course_levels WHERE course_id = ? ORDER BY level');
    return courses.map((c) => ({
      ...c,
      levels: lvlStmt.all(c.id).map((r) => r.level),
      progress_pct: c.chapter_count
        ? Math.round((c.done_chapters / c.chapter_count) * 100) : 0,
    }));
  }

  /** FR-5.1/FR-5.2 — learning tree with availability + attempt state. */
  detailForStudent(courseId, student) {
    const course = this.db.prepare(`
      SELECT c.*, u.full_name AS teacher_name, u.instructor_code FROM courses c
      JOIN users u ON u.id = c.teacher_id WHERE c.id = ?
    `).get(courseId);
    if (!course) throw notFound('Course not found.');
    if (!this.db.prepare('SELECT 1 FROM course_levels WHERE course_id = ? AND level = ?')
        .get(courseId, student.academic_level)) {
      throw forbidden('This course is not available for your academic level.');
    }

    const chapters = this.db.prepare(
      'SELECT * FROM chapters WHERE course_id = ? ORDER BY position, id').all(courseId);
    const doneRows = this.db.prepare(`
      SELECT p.chapter_id FROM progress p
      JOIN chapters h ON h.id = p.chapter_id
      WHERE h.course_id = ? AND p.student_id = ?
    `).all(courseId, student.id);
    const doneSet = new Set(doneRows.map((r) => r.chapter_id));

    const materials = this.db.prepare(`
      SELECT m.id, m.chapter_id, m.kind, m.title, m.description, m.file_name,
             m.mime, m.size_bytes, m.allow_download, m.created_at
      FROM materials m JOIN chapters h ON h.id = m.chapter_id
      WHERE h.course_id = ? ORDER BY m.created_at
    `).all(courseId);

    const quizzes = this.db.prepare(`
      SELECT z.id, z.chapter_id, z.title, z.instructions, z.time_limit_min,
             z.opens_at, z.closes_at, z.max_attempts, z.show_results
      FROM quizzes z JOIN chapters h ON h.id = z.chapter_id
      WHERE h.course_id = ? ORDER BY z.created_at
    `).all(courseId);

    const now = Date.now();
    const quizStates = quizzes.map((z) => {
      const attempts = this.db.prepare(`
        SELECT id, attempt_no, status, submitted_at, auto_score, manual_total, released_at
        FROM attempts WHERE quiz_id = ? AND student_id = ? ORDER BY attempt_no
      `).all(z.id, student.id);
      const used = attempts.length;
      const running = attempts.find((a) => a.status === 'in_progress') ?? null;
      const beforeOpen = z.opens_at ? now < Date.parse(z.opens_at) : false;
      const afterClose = z.closes_at ? now > Date.parse(z.closes_at) : false;
      const attemptsLeft = z.max_attempts ? Math.max(0, z.max_attempts - used) : null;
      let state = 'available';
      if (beforeOpen) state = 'not_open';
      else if (afterClose && !running) state = 'closed';
      else if (attemptsLeft === 0 && !running) state = 'exhausted';
      return {
        ...z,
        show_results: !!z.show_results,
        state, used_attempts: used, attempts_left: attemptsLeft,
        running_attempt_id: running?.id ?? null,
        attempts: attempts.map((a) => ({
          id: a.id, attempt_no: a.attempt_no, status: a.status,
          submitted_at: a.submitted_at, released_at: a.released_at,
          score: a.status === 'released'
            ? Math.round(((a.auto_score ?? 0) + (a.manual_total ?? 0)) * 100) / 100 : null,
        })),
        question_count: this.db.prepare(
          'SELECT COUNT(*) c FROM questions WHERE quiz_id = ?').get(z.id).c,
      };
    });

    const matBy = {}, quizBy = {};
    for (const m of materials) (matBy[m.chapter_id] ??= []).push({ ...m, allow_download: !!m.allow_download });
    for (const z of quizStates) (quizBy[z.chapter_id] ??= []).push(z);

    return {
      course: { ...course, levels: this.db.prepare(
        'SELECT level FROM course_levels WHERE course_id = ? ORDER BY level'
      ).all(courseId).map((r) => r.level) },
      chapters: chapters.map((h) => ({
        id: h.id, title: h.title, position: h.position,
        done: doneSet.has(h.id),
        materials: matBy[h.id] ?? [],
        quizzes: quizBy[h.id] ?? [],
      })),
      progress_pct: chapters.length
        ? Math.round((doneSet.size / chapters.length) * 100) : 0,
    };
  }

  /** FR-5.4 — mark done / undone (level-checked). */
  setProgress(student, chapterId, done) {
    const h = this.db.prepare(`
      SELECT h.*, c.id AS course_id FROM chapters h JOIN courses c ON c.id = h.course_id WHERE h.id = ?
    `).get(chapterId);
    if (!h) throw notFound('Chapter not found.');
    if (!this.db.prepare('SELECT 1 FROM course_levels WHERE course_id = ? AND level = ?')
        .get(h.course_id, student.academic_level)) {
      throw forbidden('This course is not available for your academic level.');
    }
    if (done) {
      this.db.prepare(
        'INSERT OR IGNORE INTO progress (student_id, chapter_id, done_at) VALUES (?,?,?)'
      ).run(student.id, chapterId, nowIso());
    } else {
      this.db.prepare('DELETE FROM progress WHERE student_id = ? AND chapter_id = ?')
        .run(student.id, chapterId);
    }
    const total = this.db.prepare('SELECT COUNT(*) c FROM chapters WHERE course_id = ?').get(h.course_id).c;
    const doneCount = this.db.prepare(`
      SELECT COUNT(*) c FROM progress p JOIN chapters ch ON ch.id = p.chapter_id
      WHERE ch.course_id = ? AND p.student_id = ?
    `).get(h.course_id, student.id).c;
    return { ok: true, done: !!done, progress_pct: total ? Math.round((doneCount / total) * 100) : 0 };
  }
}
