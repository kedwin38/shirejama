// ── Idempotent admin seed — fs-free, safe to import on any runtime ───────
// The full demo dataset (teacher/student/course/materials/quiz) needs local
// disk for its sample PDF/video and so lives in seed-demo-node.js, imported
// only by the Node entry point. This file is shared with the Worker.
import config from './config.js';
import { hashPassword } from './core/passwords.js';
import { nowIso } from './core/validate.js';

/** Seeds the admin account; returns {admin, created}. */
export async function seedAdmin(db) {
  const existing = await db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get();
  if (existing) return { admin: existing, created: false };
  const now = nowIso();
  const { lastId } = await db.prepare(`
    INSERT INTO users (role, full_name, username, email, password_hash, is_active, created_at, updated_at)
    VALUES ('admin', 'School Administrator', ?, ?, ?, 1, ?, ?)
  `).run(config.adminUsername, 'admin@shirejama.school',
         hashPassword(config.adminPassword), now, now);
  return { admin: await db.prepare('SELECT * FROM users WHERE id = ?').get(lastId), created: true };
}
