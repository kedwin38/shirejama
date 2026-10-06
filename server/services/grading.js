// ── Grading & release service (FR-4.9 / FR-4.10 / FR-3.3 pending counts) ──
import { badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { nowIso } from '../core/validate.js';

export class GradingService {
  constructor(db) { this.db = db; }

  _attemptForTeacher(attemptId, teacherId) {
    const t = this.db.prepare(`
      SELECT t.*, z.title AS quiz_title, z.show_results, c.teacher_id, c.id AS course_id, c.title AS course_title
      FROM attempts t
      JOIN quizzes z  ON z.id  = t.quiz_id
      JOIN chapters h ON h.id  = z.chapter_id
      JOIN courses  c ON c.id  = h.course_id
      WHERE t.id = ?
    `).get(attemptId);
    if (!t) throw notFound('Attempt not found.');
    if (t.teacher_id !== teacherId) throw forbidden('This attempt belongs to another teacher’s course.');
    return t;
  }

  /** FR-4.9 — submissions overview across the teacher's own courses. */
  submissions(teacherId, { quizId, status }) {
    const where = ['c.teacher_id = ?'];
    const params = [teacherId];
    if (quizId) { where.push('t.quiz_id = ?'); params.push(quizId); }
    if (status && ['in_progress', 'submitted', 'graded', 'released'].includes(status)) {
      where.push('t.status = ?'); params.push(status);
    }
    return this.db.prepare(`
      SELECT t.id, t.attempt_no, t.status, t.started_at, t.submitted_at,
             t.auto_score, t.manual_total, t.graded_at, t.released_at,
             z.id AS quiz_id, z.title AS quiz_title,
             c.id AS course_id, c.title AS course_title,
             u.id AS student_id, u.full_name AS student_name, u.student_id AS student_code,
             (SELECT COALESCE(SUM(q.points),0) FROM questions q WHERE q.quiz_id = z.id) AS max_score,
             (SELECT COUNT(*) FROM answers a WHERE a.attempt_id = t.id
                AND a.question_id IN (SELECT id FROM questions WHERE quiz_id = z.id AND type='doc')
                AND a.score IS NULL) AS unscored_doc_answers
      FROM attempts t
      JOIN quizzes z  ON z.id  = t.quiz_id
      JOIN chapters h ON h.id  = z.chapter_id
      JOIN courses  c ON c.id  = h.course_id
      JOIN users u    ON u.id  = t.student_id
      WHERE ${where.join(' AND ')}
      ORDER BY CASE t.status WHEN 'submitted' THEN 0 WHEN 'graded' THEN 1 ELSE 2 END, t.submitted_at DESC
      LIMIT 500
    `).all(...params).map((r) => ({
      ...r,
      score: r.status === 'released' || r.status === 'graded'
        ? Math.round(((r.auto_score ?? 0) + (r.manual_total ?? 0)) * 100) / 100 : null,
    }));
  }

  /** FR-4.9 — full review payload for one attempt. */
  review(teacherId, attemptId) {
    const t = this._attemptForTeacher(attemptId, teacherId);
    const student = this.db.prepare(
      'SELECT id, full_name, student_id, email, academic_level FROM users WHERE id = ?'
    ).get(t.student_id);
    const questions = this.db.prepare(
      'SELECT * FROM questions WHERE quiz_id = ? ORDER BY position, id').all(t.quiz_id);
    const answers = this.db.prepare('SELECT * FROM answers WHERE attempt_id = ?').all(attemptId);
    const ansBy = new Map(answers.map((a) => [a.question_id, a]));

    const items = questions.map((q) => {
      const a = ansBy.get(q.id);
      let options = null;
      if (q.type === 'mc') {
        options = this.db.prepare(
          'SELECT id, label, is_correct, position FROM options WHERE question_id = ? ORDER BY position'
        ).all(q.id).map((o) => ({ ...o, is_correct: !!o.is_correct }));
      }
      return {
        question_id: q.id, answer_id: a?.id ?? null, type: q.type,
        prompt: q.prompt, points: q.points,
        has_image: !!q.image_path, has_attachment: !!q.attachment_path,
        attachment_name: q.attachment_name,
        options,
        chosen_option_id: a?.option_id ?? null,
        answered_correctly: q.type === 'mc' ? (a ? !!a.is_correct : false) : null,
        text_answer: a?.text_answer ?? null,
        answer_file: a?.file_path ? { name: a.file_name, answer_id: a.id } : null,
        score: a?.score ?? null,
      };
    });

    return {
      attempt: {
        id: t.id, status: t.status, attempt_no: t.attempt_no,
        started_at: t.started_at, submitted_at: t.submitted_at,
        auto_score: t.auto_score, manual_total: t.manual_total,
        graded_at: t.graded_at, released_at: t.released_at,
        max_score: items.reduce((s, q) => s + q.points, 0),
        show_results: !!t.show_results,
      },
      quiz: { id: t.quiz_id, title: t.quiz_title },
      course: { id: t.course_id, title: t.course_title },
      student,
      items,
    };
  }

  /** FR-4.10 — record manual scores; auto-transitions to graded when done. */
  score(teacherId, attemptId, body) {
    const t = this._attemptForTeacher(attemptId, teacherId);
    if (t.status === 'in_progress') throw conflict('The student has not submitted this attempt yet.');
    if (t.status === 'released') throw conflict('This attempt has already been released to the student.');
    const scores = Array.isArray(body?.scores) ? body.scores : [];
    if (!scores.length) throw badRequest('Provide at least one score.');

    const rows = this.db.prepare('SELECT a.*, q.points, q.type FROM answers a JOIN questions q ON q.id = a.question_id WHERE a.attempt_id = ?').all(attemptId);

    return this.db.transaction(() => {
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const s of scores) {
        const row = byId.get(Number(s?.answer_id));
        if (!row) throw badRequest('Answer not part of this attempt.');
        const raw = Number(s.score);
        if (!Number.isFinite(raw) || raw < 0 || raw > row.points) {
          throw badRequest(`Score for an answer must be between 0 and ${row.points} points.`);
        }
        this.db.prepare('UPDATE answers SET score = ? WHERE id = ?').run(raw, row.id);
      }
      // Recompute totals & completion
      const fresh = this.db.prepare(`
        SELECT a.score, q.type, q.points FROM answers a JOIN questions q ON q.id = a.question_id
        WHERE a.attempt_id = ?
      `).all(attemptId);
      let auto = 0, manual = 0, docUnscored = false;
      for (const r of fresh) {
        if (r.type === 'mc') auto += r.score ?? 0;
        else {
          if (r.score == null) docUnscored = true;
          else manual += r.score;
        }
      }
      const graded = !docUnscored;
      this.db.prepare(`
        UPDATE attempts SET auto_score=?, manual_total=?, status=?, graded_at=? WHERE id=?
      `).run(auto, manual, graded ? 'graded' : t.status, graded ? nowIso() : t.graded_at, attemptId);
      return { ok: true, status: graded ? 'graded' : t.status,
               auto_score: auto, manual_total: manual, complete: graded };
    });
  }

  /** FR-4.10 — release a graded/held result to the student. */
  release(teacherId, attemptId) {
    const t = this._attemptForTeacher(attemptId, teacherId);
    if (t.status === 'released') throw conflict('This result has already been released.');
    if (t.status === 'in_progress') throw conflict('The student has not submitted this attempt yet.');
    const hasDoc = this.db.prepare(`
      SELECT 1 FROM questions q WHERE q.quiz_id = ? AND q.type='doc' LIMIT 1
    `).get(t.quiz_id);
    if (hasDoc) {
      const unscored = this.db.prepare(`
        SELECT COUNT(*) c FROM answers a JOIN questions q ON q.id = a.question_id
        WHERE a.attempt_id = ? AND q.type = 'doc' AND a.score IS NULL
      `).get(attemptId).c;
      if (unscored > 0) {
        throw conflict(`Score all ${unscored} document answer(s) before releasing this result.`);
      }
    }
    this.db.prepare("UPDATE attempts SET status='released', released_at=? WHERE id=?")
      .run(nowIso(), attemptId);
    return { ok: true };
  }
}
