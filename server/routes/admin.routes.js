// ── Administrator routes (FR-3.x + FR-7 backup console) ──────────────────
import { requireAuth } from '../core/auth.js';

export function registerAdminRoutes(router, ctx) {
  const { services } = ctx;
  const admin = requireAuth('admin');

  // ── Institution stats ──────────────────────────────────────────────────
  router.get('/api/admin/stats', async (r, q, c) => { admin(c); return await services.users.stats(); });

  // ── Analytics (teacher performance rollup) ─────────────────────────────
  router.get('/api/admin/analytics/teachers', async (r, q, c) => {
    admin(c);
    return {
      summary: await services.analytics.institutionSummary(),
      teachers: await services.analytics.teacherAnalytics(),
    };
  });

  router.get('/api/admin/activity', async (req, res, c) => {
    admin(c);
    return { signins: await services.users.recentSignins(Number(c.query.limit) || 30) };
  });

  // ── Accounts ───────────────────────────────────────────────────────────
  router.get('/api/admin/users', async (req, res, c) => {
    admin(c);
    return { users: await services.users.list(c.query) };
  });

  router.post('/api/admin/teachers', async (req, res, c) => {
    admin(c);
    return { user: await services.users.createTeacher(c.body) };
  });

  router.post('/api/admin/students', async (req, res, c) => {
    admin(c);
    return { user: await services.users.createStudent(c.body) };
  });

  // Bulk provision: rows parsed client-side from CSV/XLSX ({name, student_id}),
  // one academic level + one default password for the whole upload. Students
  // whose ID already has an account are skipped and reported.
  router.post('/api/admin/students/bulk', async (req, res, c) => {
    admin(c);
    return await services.users.bulkProvisionStudents(c.body ?? {});
  });

  router.patch('/api/admin/users/:id', async (req, res, c) => {
    admin(c);
    return { user: await services.users.update(Number(c.params.id), c.body ?? {}) };
  });

  router.post('/api/admin/users/:id/reset-password', async (req, res, c) => {
    admin(c);
    return await services.users.resetPassword(Number(c.params.id), c.body?.password);
  });

  router.delete('/api/admin/users/:id', async (req, res, c) => {
    admin(c);
    return await services.users.delete(Number(c.params.id));
  });

  // Bulk delete — per-row guards still apply; returns a full report of what
  // was deleted and what was refused (and why).
  router.post('/api/admin/users/bulk-delete', async (req, res, c) => {
    admin(c);
    return await services.users.bulkDelete(c.body?.ids ?? []);
  });

  // ── Backup console (FR-7) — admin-connected S3-compatible storage ─────
  router.get('/api/admin/backups', async (req, res, c) => {
    admin(c);
    return { config: await services.backups.config(), history: await services.backups.history() };
  });

  router.put('/api/admin/backups/config', async (req, res, c) => {
    admin(c);
    return { config: await services.backups.updateConfig(c.body ?? {}) };
  });

  // Verify the connection: writes + removes a probe object in the bucket.
  router.post('/api/admin/backups/test', async (req, res, c) => {
    admin(c);
    return await services.backups.testConnection();
  });

  router.post('/api/admin/backups/run', async (req, res, c) => {
    admin(c);
    const rec = await services.backups.run({ scope: c.body?.scope });
    return { backup: { id: rec.id, file_name: rec.file_name, scope: rec.scope,
                       format: rec.format, size_bytes: rec.size_bytes,
                       status: rec.status, created_at: rec.created_at } };
  });

  router.get('/api/admin/backups/:id/download', async (req, res, c) => {
    admin(c);
    const { row, bytes } = await services.backups.download(Number(c.params.id));
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${row.file_name.replace(/["\\\r\n]/g, '_')}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  router.delete('/api/admin/backups/:id', async (req, res, c) => {
    admin(c);
    return await services.backups.remove(Number(c.params.id));
  });
}
