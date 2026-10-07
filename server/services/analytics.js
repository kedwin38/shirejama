// ── Analytics service — institutional & per-course insight ───────────────
// Admin: how is every teacher performing? Teacher: how is every cohort
// engaging with a course? Pure read-model queries; no writes.
import { forbidden, notFound } from '../core/errors.js';

export class AnalyticsService {
  constructor(db) { this.db = db; }

  /** Per-teacher rollup across everything they own. */
  async teacherAnalytics() {
    const rows = await this.db.prepare(`
      SELECT u.id, u.full_name, u.instructor_code, u.email,
             u.is_active, u.created_at,
        (SELECT COUNT(*) FROM courses c WHERE c.teacher_id = u.id) AS course_count,
        (SELECT COUNT(*) FROM chapters h JOIN courses c ON c.id = h.course_id
           WHERE c.teacher_id = u.id) AS chapter_count,
        (SELECT COUNT(*) FROM materials m JOIN chapters h ON h.id = m.chapter_id
           JOIN courses c ON c.id = h.course_id WHERE c.teacher_id = u.id) AS material_count,
        (SELECT COUNT(*) FROM quizzes z JOIN chapters h ON h.id = z.chapter_id
           JOIN courses c ON c.id = h.course_id WHERE c.teacher_id = u.id) AS quiz_count,
        (SELECT COUNT(DISTINCT t.student_id) FROM attempts t
           JOIN quizzes z ON z.id = t.quiz_id
           JOIN chapters h ON h.id = z.chapter_id
           JOIN courses c ON c.id = h.course_id
           WHERE c.teacher_id = u.id) AS students_engaged,
        (SELECT COUNT(*) FROM attempts t
           JOIN quizzes z ON z.id = t.quiz_id
           JOIN chapters h ON h.id = z.chapter_id
           JOIN courses c ON c.id = h.course_id
           WHERE c.teacher_id = u.id) AS attempt_count,
        (SELECT COUNT(*) FROM attempts t
           JOIN quizzes z ON z.id = t.quiz_id
           JOIN chapters h ON h.id = z.chapter_id
           JOIN courses c ON c.id = h.course_id
           WHERE c.teacher_id = u.id AND t.status = 'submitted') AS pending_grading,
        (SELECT ROUND(AVG(
             CASE WHEN t.status = 'released' AND dz.max_points > 0
                  THEN (t.auto_score + t.manual_total) * 100.0 / dz.max_points END), 1)
           FROM attempts t
           JOIN (SELECT z2.id, COALESCE(SUM(q.points), 0) AS max_points
                 FROM quizzes z2 JOIN questions q ON q.quiz_id = z2.id
                 GROUP BY z2.id) dz ON dz.id = t.quiz_id
           JOIN chapters h ON h.id = (SELECT chapter_id FROM quizzes WHERE id = t.quiz_id)
           JOIN courses c ON c.id = h.course_id
           WHERE c.teacher_id = u.id) AS avg_score_pct,
        (SELECT MAX(t.started_at) FROM attempts t
           JOIN quizzes z ON z.id = t.quiz_id
           JOIN chapters h ON h.id = z.chapter_id
           JOIN courses c ON c.id = h.course_id
           WHERE c.teacher_id = u.id) AS last_activity
      FROM users u
      WHERE u.role = 'teacher'
      ORDER BY course_count DESC, u.full_name
    `).all();
    return rows.map((r) => ({ ...r, is_active: !!r.is_active }));
  }

  /** Institution totals for the analytics header. */
  async institutionSummary() {
    const one = async (sql) => Number((await this.db.prepare(sql).get()).c ?? 0);
    const avgRow = await this.db.prepare(`
      SELECT ROUND(AVG(
        CASE WHEN t.status = 'released' AND dz.max_points > 0
             THEN (t.auto_score + t.manual_total) * 100.0 / dz.max_points END), 1) AS v
      FROM attempts t
      JOIN (SELECT z.id, COALESCE(SUM(q.points),0) AS max_points FROM quizzes z
            JOIN questions q ON q.quiz_id = z.id GROUP BY z.id) dz ON dz.id = t.quiz_id
    `).get();
    return {
      teachers: await one(`SELECT COUNT(*) c FROM users WHERE role='teacher'`),
      students: await one(`SELECT COUNT(*) c FROM users WHERE role='student'`),
      courses: await one(`SELECT COUNT(*) c FROM courses`),
      materials: await one(`SELECT COUNT(*) c FROM materials`),
      quizzes: await one(`SELECT COUNT(*) c FROM quizzes`),
      attempts: await one(`SELECT COUNT(*) c FROM attempts`),
      pendingGrading: await one(`SELECT COUNT(*) c FROM attempts WHERE status='submitted'`),
      avgScorePct: avgRow.v == null ? null : Number(avgRow.v),
    };
  }

  /**
   * Cohort analytics for one course (teacher-owned): everyone at the
   * course's levels, their chapter progress, and quiz outcomes.
   */
  async courseAnalytics(teacherId, courseId) {
    const course = await this.db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
    if (!course) throw notFound('Course not found.');
    if (course.teacher_id !== teacherId) {
      throw forbidden('You can only view analytics for your own courses.');
    }
    const levelRows = await this.db.prepare(
      'SELECT level FROM course_levels WHERE course_id = ? ORDER BY level'
    ).all(courseId);
    const levels = levelRows.map((r) => r.level);

    const ph = levels.map(() => '?').join(',');
    const cohortRows = levels.length
      ? await this.db.prepare(`
          SELECT id, full_name, student_id, academic_level, is_active FROM users
          WHERE role = 'student' AND academic_level IN (${ph}) ORDER BY full_name
        `).all(...levels)
      : [];
    const cohort = cohortRows.map((s) => ({ ...s, is_active: !!s.is_active }));
    const ids = cohort.map((s) => s.id);
    const inCohort = ids.length ? ids.map(() => '?').join(',') : 'NULL';

    const chapters = await this.db.prepare(
      'SELECT id, title, position FROM chapters WHERE course_id = ? ORDER BY position, id'
    ).all(courseId);
    const chapterDoneRows = await this.db.prepare(`
      SELECT p.chapter_id, COUNT(*) c FROM progress p
      WHERE p.chapter_id IN (SELECT id FROM chapters WHERE course_id = ?)
        AND p.student_id IN (${inCohort})
      GROUP BY p.chapter_id
    `).all(courseId, ...ids);
    const chapterDone = new Map(chapterDoneRows.map((r) => [r.chapter_id, r.c]));

    const quizRows = await this.db.prepare(`
      SELECT z.id, z.title FROM quizzes z
      JOIN chapters h ON h.id = z.chapter_id WHERE h.course_id = ? ORDER BY z.created_at
    `).all(courseId);
    const quizzes = [];
    for (const z of quizRows) {
      const agg = await this.db.prepare(`
        SELECT COUNT(*) AS attempts,
               COUNT(DISTINCT t.student_id) AS students,
               SUM(CASE WHEN t.status = 'submitted' THEN 1 ELSE 0 END) AS pending,
               ROUND(AVG(CASE WHEN t.status = 'released' AND dz.mp > 0
                     THEN (t.auto_score + t.manual_total) * 100.0 / dz.mp END), 1) AS avg_pct
        FROM attempts t
        JOIN (SELECT COALESCE(SUM(q.points), 0) AS mp FROM questions q WHERE q.quiz_id = ?) dz
        WHERE t.quiz_id = ?
      `).get(z.id, z.id);
      const qc = await this.db.prepare('SELECT COUNT(*) c FROM questions WHERE quiz_id = ?').get(z.id);
      quizzes.push({
        id: z.id, title: z.title,
        question_count: qc.c,
        attempts: agg.attempts ?? 0,
        students: agg.students ?? 0,
        pending: agg.pending ?? 0,
        avg_pct: agg.avg_pct == null ? null : Number(agg.avg_pct),
      });
    }

    const perStudent = [];
    for (const s of cohort) {
      const doneRow = await this.db.prepare(`
        SELECT COUNT(*) c FROM progress p JOIN chapters h ON h.id = p.chapter_id
        WHERE h.course_id = ? AND p.student_id = ?
      `).get(courseId, s.id);
      const att = await this.db.prepare(`
        SELECT COUNT(*) AS attempts,
               SUM(CASE WHEN t.status = 'submitted' THEN 1 ELSE 0 END) AS pending,
               MAX(t.started_at) AS last_activity
        FROM attempts t
        JOIN quizzes z ON z.id = t.quiz_id
        JOIN chapters h ON h.id = z.chapter_id
        WHERE h.course_id = ? AND t.student_id = ?
      `).get(courseId, s.id);
      const avgRow = await this.db.prepare(`
        SELECT ROUND(AVG(CASE WHEN t.status = 'released' AND dz.mp > 0
              THEN (t.auto_score + t.manual_total) * 100.0 / dz.mp END), 1) AS v
        FROM attempts t
        JOIN (SELECT z2.id, COALESCE(SUM(q.points), 0) AS mp FROM quizzes z2
              JOIN questions q ON q.quiz_id = z2.id GROUP BY z2.id) dz ON dz.id = t.quiz_id
        JOIN quizzes z ON z.id = t.quiz_id
        JOIN chapters h ON h.id = z.chapter_id
        WHERE h.course_id = ? AND t.student_id = ?
      `).get(courseId, s.id);
      perStudent.push({
        ...s,
        chapters_done: doneRow.c,
        completion_pct: chapters.length ? Math.round((doneRow.c / chapters.length) * 100) : 0,
        attempts: att.attempts ?? 0,
        pending: att.pending ?? 0,
        avg_score_pct: avgRow.v == null ? null : Number(avgRow.v),
        last_activity: att.last_activity ?? null,
      });
    }

    const completions = perStudent.filter(
      (s) => chapters.length && s.chapters_done === chapters.length).length;

    const materialsCount = await this.db.prepare(`
      SELECT COUNT(*) c FROM materials m JOIN chapters h ON h.id = m.chapter_id
      WHERE h.course_id = ?`).get(courseId);

    return {
      course: { id: course.id, title: course.title, levels },
      summary: {
        cohort_size: cohort.length,
        chapters: chapters.length,
        materials: materialsCount.c,
        quizzes: quizzes.length,
        avg_completion_pct: cohort.length
          ? Math.round(perStudent.reduce((a, s) => a + s.completion_pct, 0) / cohort.length) : 0,
        fully_completed_students: completions,
      },
      chapters: chapters.map((h) => ({
        id: h.id, title: h.title,
        students_done: chapterDone.get(h.id) ?? 0,
        done_pct: cohort.length ? Math.round(((chapterDone.get(h.id) ?? 0) / cohort.length) * 100) : 0,
      })),
      quizzes,
      students: perStudent,
    };
  }
}
