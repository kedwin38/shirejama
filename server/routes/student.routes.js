// ── Student routes (FR-5.x) ──────────────────────────────────────────────
import { requireAuth } from '../core/auth.js';
import { badRequest } from '../core/errors.js';

export function registerStudentRoutes(router, ctx) {
  const { services } = ctx;
  const student = requireAuth('student');

  // ── Catalog (FR-5.1) ───────────────────────────────────────────────────
  router.get('/api/student/courses', async (req, res, c) =>
    (student(c), { courses: services.catalog.listForStudent(c.user) }));

  router.get('/api/student/courses/:id', async (req, res, c) => {
    student(c);
    return services.catalog.detailForStudent(Number(c.params.id), c.user);
  });

  // ── Progress (FR-5.4) ──────────────────────────────────────────────────
  router.put('/api/student/progress/:chapterId', async (req, res, c) => {
    student(c);
    return services.catalog.setProgress(c.user, Number(c.params.chapterId), !!c.body?.done);
  });

  // ── Quiz runtime (FR-5.5 / FR-5.6) ─────────────────────────────────────
  router.post('/api/student/quizzes/:id/start', async (req, res, c) => {
    student(c);
    return services.attempts.start(Number(c.params.id), c.user);
  });

  router.get('/api/student/attempts/:id', async (req, res, c) => {
    student(c);
    return services.attempts.runningPayload(Number(c.params.id), c.user);
  });

  router.put('/api/student/attempts/:id/autosave', async (req, res, c) => {
    student(c);
    return services.attempts.autosave(Number(c.params.id), c.user, c.body);
  });

  router.put('/api/student/attempts/:id/answer-file', async (req, res, c) => {
    student(c);
    const qid = Number(c.query.question_id);
    if (!qid) throw badRequest('question_id is required.');
    return services.attempts.uploadAnswerFile(
      Number(c.params.id), c.user, qid, req, c.query.name);
  });

  router.post('/api/student/attempts/:id/submit', async (req, res, c) => {
    student(c);
    return services.attempts.submit(Number(c.params.id), c.user, c.body);
  });

  // ── Results (FR-5.7 / FR-5.8) ──────────────────────────────────────────
  router.get('/api/student/results', async (req, res, c) =>
    (student(c), { attempts: services.attempts.history(c.user) }));

  router.get('/api/student/results/:id', async (req, res, c) => {
    student(c);
    return services.attempts.breakdown(Number(c.params.id), c.user);
  });
}
