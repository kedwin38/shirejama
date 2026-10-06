// ── DatabasePort · adapter over node:sqlite (ADR-001) ───────────────────
// The rest of the codebase depends only on this port, never on the driver,
// keeping the documented PostgreSQL migration path open (ADR-005 / docs).
import { DatabaseSync } from 'node:sqlite';

export class DatabasePort {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
    `);
  }

  exec(sql) { this.db.exec(sql); }

  prepare(sql) {
    const st = this.db.prepare(sql);
    return {
      run: (...p) => {
        const r = st.run(...p);
        return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
      },
      get: (...p) => st.get(...p),
      all: (...p) => st.all(...p),
    };
  }

  // IMMEDIATE grabs the write lock up front → no mid-transaction upgrade
  // failures under concurrency (NFR-2).
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }

  close() { this.db.close(); }
}
