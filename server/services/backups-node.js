// ── Node-only backup strategies: local disk target, SQLite snapshot ───────
// Kept out of backups.js so that file stays import-safe for the Worker
// bundle (no node:fs / node:sqlite in its module graph).
import { statSync, unlinkSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { BackupTarget, BackupFormat, SCOPES } from './backups.js';

export class LocalDiskTarget extends BackupTarget {
  constructor(dir) { super(); this.dir = dir; }
  async save(name, produced) {
    const dest = join(this.dir, name);
    writeFileSync(dest, produced.bytes);
    return { storedPath: dest, size: produced.bytes.length };
  }
  async remove(storedPath) { try { unlinkSync(storedPath); } catch {} }
}

// S3Target/R2Target slot in here later — same 3 methods, zero call-site edits.

/** Consistent online snapshot via VACUUM INTO, pruned to the scope. */
export class SQLiteSnapshotFormat extends BackupFormat {
  get id() { return 'sqlite'; }
  async produce(db, dbFile, scope) {
    const dir = mkdtempSync(join(tmpdir(), 'sjlms-backup-'));
    const tmp = join(dir, 'snapshot.db');
    try {
      // VACUUM INTO yields a transactionally consistent copy while live.
      await db.prepare('VACUUM INTO ?').run(tmp);
      const keep = SCOPES[scope];
      // Engine/runtime tables never travel inside backups.
      const never = ['sessions', 'backup_config', 'backups'];
      const snap = new DatabaseSync(tmp);
      try {
        // FK-safe purge order (children before parents).
        const purgeOrder = ['answers', 'attempts', 'progress', 'options', 'questions',
                            'quizzes', 'materials', 'chapters', 'course_levels',
                            'courses', 'sessions', 'users'];
        snap.exec('PRAGMA foreign_keys = OFF;');
        for (const t of purgeOrder) {
          if (!keep.includes(t) || never.includes(t)) snap.exec(`DELETE FROM ${t};`);
        }
      } finally {
        snap.close();
      }
      return { bytes: readFileSync(tmp) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
