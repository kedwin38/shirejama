// ── DatabasePort · adapter over node:sqlite (ADR-001) ───────────────────
// The rest of the codebase depends only on this port, never on the driver,
// keeping the documented PostgreSQL / D1 migration path open (ADR-005).
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
    // Transaction bodies are async (shared with the D1-backed Worker port),
    // but this is still one synchronous connection shared by every request.
    // Queue transactions so two in-flight requests never interleave their
    // BEGIN/COMMIT on the same handle (NFR-2) — the single-statement calls
    // outside a transaction() don't need this, node:sqlite serializes those.
    this._txQueue = Promise.resolve();
  }

  exec(sql) { this.db.exec(sql); }

  prepare(sql) {
    const st = this.db.prepare(sql);
    return {
      run: async (...p) => {
        const r = st.run(...p);
        return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
      },
      get: async (...p) => st.get(...p),
      all: async (...p) => st.all(...p),
    };
  }

  // IMMEDIATE grabs the write lock up front → no mid-transaction upgrade
  // failures under concurrency (NFR-2). Queued so concurrent callers run
  // one transaction at a time instead of interleaving on the shared handle.
  transaction(fn) {
    const run = async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const out = await fn();
        this.db.exec('COMMIT');
        return out;
      } catch (e) {
        try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw e;
      }
    };
    const result = this._txQueue.then(run, run);
    // Keep the queue alive regardless of this call's outcome.
    this._txQueue = result.then(() => {}, () => {});
    return result;
  }

  close() { this.db.close(); }
}
