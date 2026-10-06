// ── Teacher routes (FR-4.x) ──────────────────────────────────────────────
import { requireAuth } from '../core/auth.js';
import { badRequest } from '../core/errors.js';

export function registerTeacherRoutes(router, ctx) {
  const { services } = ctx;
  const teacher = requireAuth('teacher');

  // ── Courses (FR-4.1 / FR-4.2) ──────────────────────────────────────────
  router.get('/api/teacher/courses', async (req, res, c) =>
    (teacher(c), { courses: services.courses.listForTeacher(c.user.id) }));

  router.post('/api/teacher/courses', async (req, res, c) => {
    teacher(c);
    return { course: services.courses.create(c.user.id, c.body ?? {}) };
  });

  router.get('/api/teacher/courses/:id', async (req, res, c) => {
    teacher(c);
    return { course: services.courses.detail(c.user.id, Number(c.params.id), { authoring: true }) };
  });

  // ── Cohort analytics for one course ────────────────────────────────────
  router.get('/api/teacher/courses/:id/analytics', async (req, res, c) => {
    teacher(c);
    return services.analytics.courseAnalytics(c.user.id, Number(c.params.id));
  });

  router.patch('/api/teacher/courses/:id', async (req, res, c) => {
    teacher(c);
    return { course: services.courses.update(c.user.id, Number(c.params.id), c.body ?? {}) };
  });

  router.delete('/api/teacher/courses/:id', async (req, res, c) => {
    teacher(c);
    return services.courses.delete(c.user.id, Number(c.params.id));
  });

  // ── Chapters (FR-4.3) ──────────────────────────────────────────────────
  router.post('/api/teacher/courses/:id/chapters', async (req, res, c) => {
    teacher(c);
    return { chapter: services.courses.addChapter(c.user.id, Number(c.params.id), c.body?.title) };
  });

  router.patch('/api/teacher/chapters/:id', async (req, res, c) => {
    teacher(c);
    return services.courses.renameChapter(c.user.id, Number(c.params.id), c.body?.title);
  });

  router.delete('/api/teacher/chapters/:id', async (req, res, c) => {
    teacher(c);
    return services.courses.deleteChapter(c.user.id, Number(c.params.id));
  });

  router.post('/api/teacher/chapters/:id/move', async (req, res, c) => {
    teacher(c);
    return services.courses.moveChapter(c.user.id, Number(c.params.id), c.body?.dir);
  });

  // ── Materials (FR-4.4 / FR-4.5) — raw streamed upload, meta in query ──
  router.put('/api/teacher/chapters/:id/materials', async (req, res, c) => {
    teacher(c);
    // body was NOT parsed (content-type is not JSON) — stream it straight in
    const material = await services.courses.addMaterial(
      c.user.id, Number(c.params.id), c.query, req);
    return { material };
  });

  router.delete('/api/teacher/materials/:id', async (req, res, c) => {
    teacher(c);
    return services.courses.deleteMaterial(c.user.id, Number(c.params.id));
  });

  // ── Quizzes (FR-4.6) ───────────────────────────────────────────────────
  router.post('/api/teacher/chapters/:id/quizzes', async (req, res, c) => {
    teacher(c);
    return { quiz: services.quizzes.create(c.user.id, Number(c.params.id), c.body ?? {}) };
  });

  router.patch('/api/teacher/quizzes/:id', async (req, res, c) => {
    teacher(c);
    return { quiz: services.quizzes.update(c.user.id, Number(c.params.id), c.body ?? {}) };
  });

  router.delete('/api/teacher/quizzes/:id', async (req, res, c) => {
    teacher(c);
    return services.quizzes.delete(c.user.id, Number(c.params.id));
  });

  // ── Question file staging (step 1 of FR-4.7) ──────────────────────────
  router.put('/api/teacher/files/question', async (req, res, c) => {
    teacher(c);
    const kind = c.query.kind === 'attachment' ? 'attachment' : 'image';
    if (!['image', 'attachment'].includes(c.query.kind)) {
      throw badRequest('Question file kind must be "image" or "attachment".');
    }
    const staged = await services.vault.stageQuestionFile(req, kind, c.query.name);
    return staged;
  });

  // ── Questions (FR-4.7) ─────────────────────────────────────────────────
  router.post('/api/teacher/quizzes/:id/questions', async (req, res, c) => {
    teacher(c);
    return { question: services.quizzes.addQuestion(c.user.id, Number(c.params.id), c.body ?? {}) };
  });

  router.delete('/api/teacher/questions/:id', async (req, res, c) => {
    teacher(c);
    return services.quizzes.deleteQuestion(c.user.id, Number(c.params.id));
  });

  // ── Submissions & grading (FR-4.9 / FR-4.10) ───────────────────────────
  router.get('/api/teacher/submissions', async (req, res, c) => {
    teacher(c);
    return { submissions: services.grading.submissions(c.user.id, {
      quizId: c.query.quiz_id ? Number(c.query.quiz_id) : null,
      status: c.query.status,
    }) };
  });

  router.get('/api/teacher/attempts/:id', async (req, res, c) => {
    teacher(c);
    return services.grading.review(c.user.id, Number(c.params.id));
  });

  router.post('/api/teacher/attempts/:id/score', async (req, res, c) => {
    teacher(c);
    return services.grading.score(c.user.id, Number(c.params.id), c.body);
  });

  router.post('/api/teacher/attempts/:id/release', async (req, res, c) => {
    teacher(c);
    return services.grading.release(c.user.id, Number(c.params.id));
  });
}
