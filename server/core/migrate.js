// ── Schema migrations · idempotent, shared by Node boot and D1 one-shot ──
// Detects the pre-change schema via pragma_table_info / sqlite_master and
// returns the SQL that upgrades it. Node runs it inside a transaction at
// boot; the D1 (Worker) copy is applied as one atomic multi-statement call.
//
// Changes covered:
//   1. users.email becomes NULLABLE (students have no email at all)
//   2. materials gains the 'link' kind + link_url column (external resources)
//   3. courses gains resource_url (course-level external learning material)

/** Which migrations are pending for this database? */
export async function pendingMigrations(db) {
  const out = [];

  // 1 · users.email NOT NULL → nullable
  const emailCol = await db.prepare(
    `SELECT "notnull" AS nn FROM pragma_table_info('users') WHERE name = 'email'`
  ).get();
  if (emailCol && Number(emailCol.nn) === 1) out.push('users_email_nullable');

  // 2 · materials: 'link' kind + link_url column
  const matSql = await db.prepare(
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'materials'`
  ).get();
  const linkUrlCol = await db.prepare(
    `SELECT 1 FROM pragma_table_info('materials') WHERE name = 'link_url'`
  ).get();
  if (matSql && (!matSql.sql.includes("'link'") || !linkUrlCol)) out.push('materials_link');

  // 3 · courses.resource_url (plain ADD COLUMN — no constraint changes)
  const courseCol = await db.prepare(
    `SELECT 1 FROM pragma_table_info('courses') WHERE name = 'resource_url'`
  ).get();
  if (!courseCol) out.push('courses_resource_url');

  return out;
}

/** Build the SQL for one migration by name (all statements, in order). */
export function migrationSql(name) {
  switch (name) {
    case 'users_email_nullable':
      // Table rebuild (SQLite cannot drop a NOT NULL). FKs pointing at users
      // (sessions → CASCADE, courses.teacher_id) survive: rows are preserved
      // with identical ids, and the table is renamed back in place. Sessions
      // are ephemeral and simply cleared first to avoid intermediate locks.
      return [
        'DELETE FROM sessions;',
        `CREATE TABLE users_mig (
           id             INTEGER PRIMARY KEY AUTOINCREMENT,
           role           TEXT NOT NULL CHECK (role IN ('admin','teacher','student')),
           full_name      TEXT NOT NULL,
           username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
           email          TEXT UNIQUE COLLATE NOCASE,
           password_hash  TEXT NOT NULL,
           is_active      INTEGER NOT NULL DEFAULT 1,
           instructor_code TEXT UNIQUE,
           student_id     TEXT UNIQUE,
           academic_level TEXT CHECK (academic_level IS NULL OR academic_level IN
             ('C1','C2','C3','C4','C5','C6','C7','C8','F1','F2','F3','F4')),
           created_at     TEXT NOT NULL,
           updated_at     TEXT NOT NULL
         );`,
        `INSERT INTO users_mig (id, role, full_name, username, email, password_hash,
            is_active, instructor_code, student_id, academic_level, created_at, updated_at)
         SELECT id, role, full_name, username,
            CASE WHEN role = 'student' THEN NULL ELSE email END,
            password_hash, is_active, instructor_code, student_id, academic_level,
            created_at, updated_at
         FROM users;`,
        'DROP TABLE users;',
        'ALTER TABLE users_mig RENAME TO users;',
        'CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role);',
        'CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);',
      ].join('\n');

    case 'materials_link':
      // Table rebuild to widen the kind CHECK and add link_url. materials has
      // no inbound foreign keys, so the drop/rename is safe.
      return [
        `CREATE TABLE materials_mig (
           id             INTEGER PRIMARY KEY AUTOINCREMENT,
           chapter_id     INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
           kind           TEXT NOT NULL CHECK (kind IN ('pdf','video','link')),
           title          TEXT NOT NULL,
           description    TEXT NOT NULL DEFAULT '',
           file_name      TEXT NOT NULL DEFAULT '',
           stored_path    TEXT,
           mime           TEXT NOT NULL DEFAULT '',
           size_bytes     INTEGER NOT NULL DEFAULT 0,
           allow_download INTEGER NOT NULL DEFAULT 0,
           link_url       TEXT,
           created_at     TEXT NOT NULL
         );`,
        `INSERT INTO materials_mig (id, chapter_id, kind, title, description, file_name,
            stored_path, mime, size_bytes, allow_download, link_url, created_at)
         SELECT id, chapter_id, kind, title, description, file_name,
            NULLIF(stored_path, ''), NULLIF(mime, ''), size_bytes, allow_download,
            NULL, created_at
         FROM materials;`,
        'DROP TABLE materials;',
        'ALTER TABLE materials_mig RENAME TO materials;',
        'CREATE INDEX IF NOT EXISTS idx_materials_chapter ON materials(chapter_id);',
      ].join('\n');

    case 'courses_resource_url':
      return 'ALTER TABLE courses ADD COLUMN resource_url TEXT;';

    default:
      throw new Error('Unknown migration: ' + name);
  }
}

/** Apply all pending migrations (Node path — caller may wrap in a transaction). */
export async function migrate(db) {
  const pending = await pendingMigrations(db);
  for (const name of pending) {
    const sql = migrationSql(name);
    if (db.exec) {
      await db.exec(sql);
    } else {
      for (const stmt of sql.split(/;\s*\n/)) {
        const t = stmt.trim();
        if (t) await db.prepare(t).run();
      }
    }
  }
  return pending;
}
