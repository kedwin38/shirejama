// ── File vault routes (FR-6.x) — every byte is permission-checked ────────
import { notFound } from '../core/errors.js';

export function registerFileRoutes(router, ctx) {
  const { services } = ctx;
  const vault = services.vault;

  const isStudentOfCourse = async (user, courseId) =>
    user?.role === 'student' && (await vault.courseLevels(courseId)).includes(user.academic_level);

  /**
   * FR-6.2 — course material. Students: only if the course matches their
   * level. Teachers: only the owner. Admins: always. ?download=1 additionally
   * requires the teacher to have allowed downloads (FR-4.4).
   */
  router.get('/api/files/material/:id', async (req, res, c) => {
    const m = await vault.materialContext(Number(c.params.id));
    if (!m) throw notFound('Material not found.');
    const { user } = c;
    let allowed = user?.role === 'admin' || (user?.role === 'teacher' && user.id === m.teacher_id);
    if (!allowed && await isStudentOfCourse(user, m.course_id)) allowed = true;
    if (!allowed) throw notFound('Material not found.');

    const wantsDownload = c.query.download === '1';
    return await ctx.serveFile(req, res, {
      path: m.stored_path, mime: m.mime, size: m.size_bytes, fileName: m.file_name,
      download: wantsDownload && m.allow_download === 1,
    });
  });

  /** Question image (MC) or document attachment (DOC). */
  router.get('/api/files/question/:id', async (req, res, c) => {
    const q = await vault.questionContext(Number(c.params.id));
    if (!q) throw notFound('File not found.');
    const kind = c.query.kind === 'attachment' ? 'attachment_path' : 'image_path';
    const path = q[kind];
    if (!path) throw notFound('File not found.');
    const { user } = c;
    let allowed = user?.role === 'admin' || (user?.role === 'teacher' && user.id === q.teacher_id);
    if (!allowed && await isStudentOfCourse(user, q.course_id)) allowed = true;
    if (!allowed) throw notFound('File not found.');
    return await ctx.serveFile(req, res, {
      path,
      mime: kind === 'image_path' ? 'image/png'
        : (q.attachment_name?.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream'),
      size: 0, fileName: q.attachment_name || 'question-file',
      download: kind === 'attachment_path',
    });
  });

  /** FR-6.3 — a student's answer file: owner student, owning teacher, admin. */
  router.get('/api/files/answer/:id', async (req, res, c) => {
    const a = await vault.answerContext(Number(c.params.id));
    if (!a) throw notFound('File not found.');
    const { user } = c;
    const allowed = user?.role === 'admin'
      || (user?.role === 'teacher' && user.id === a.teacher_id)
      || (user?.role === 'student' && user.id === a.student_id);
    if (!allowed) throw notFound('File not found.');
    return await ctx.serveFile(req, res, {
      path: a.file_path, mime: 'application/octet-stream', size: 0,
      fileName: a.file_name || 'answer-file', download: true,
    });
  });
}
