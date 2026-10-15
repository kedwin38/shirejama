// ── DatabasePort · adapter over D1 (ADR-001 / ADR-005 migration path) ────
// Same shape as server/core/db.js so every service/route file is shared,
// unmodified, between the Node server and this Worker.
import { AppError } from '../server/core/errors.js';
import { log } from '../server/core/log.js';

// D1's storage layer occasionally stalls for tens of seconds (a documented,
// intermittent platform issue). Without a local deadline a stalled call hangs
// the whole request until the browser's abort fires — users saw this as the
// login "time out". Racing every D1 operation converts stalls into a fast,
// clean, retryable 503 instead.
const DEFAULT_DEADLINE_MS = 10_000;
const MIGRATION_DEADLINE_MS = 30_000;

export class D1Port {
  constructor(d1, { deadlineMs = DEFAULT_DEADLINE_MS } = {}) {
    this.db = d1;
    this.deadlineMs = deadlineMs;
  }

  /** Race a D1 operation against a deadline; losers are logged, never fatal. */
  _g(promise, ms = this.deadlineMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        log.warn('db_deadline', { ms, hint: 'D1 storage stalled — request failed fast instead of hanging' });
        reject(new AppError(503, 'db_unavailable',
          'The database is responding slowly — please try again in a moment.'));
      }, ms);
    });
    promise.catch(() => {}); // late-arriving loser must not become an unhandled rejection
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  async exec(sql) {
    // D1's raw exec() splits statements naively and rejects multi-line DDL
    // ("incomplete input"). Split on statement boundaries ourselves and run
    // one atomic batch instead — same all-or-nothing semantics, and prepared
    // statements happily span lines.
    if (typeof this.db.batch === 'function') {
      const stmts = sql
        .split(/;\s*\n/)
        .map((s) => s.trim().replace(/;$/, ''))
        .filter(Boolean)
        .map((s) => this.db.prepare(s));
      if (stmts.length) await this._g(this.db.batch(stmts), MIGRATION_DEADLINE_MS);
      return;
    }
    await this.db.exec(sql);
  }

  /**
   * One-round-trip multi-statement write: [{sql, params}] → D1 batch().
   * Falls back to sequential execution when the adapter underneath has no
   * native batch (the Node port runs statements inside a transaction).
   */
  async batch(statements) {
    if (typeof this.db.batch === 'function') {
      await this._g(this.db.batch(statements.map((s) => this.db.prepare(s.sql).bind(...s.params))));
      return;
    }
    for (const s of statements) await this.prepare(s.sql).run(...s.params);
  }

  prepare(sql) {
    const stmt = this.db.prepare(sql);
    return {
      run: async (...p) => {
        const r = await this._g(stmt.bind(...p).run());
        return { changes: r.meta?.changes ?? 0, lastId: r.meta?.last_row_id ?? 0 };
      },
      get: async (...p) => (await this._g(stmt.bind(...p).first())) ?? null,
      all: async (...p) => (await this._g(stmt.bind(...p).all())).results ?? [],
    };
  }

  /**
   * D1's Workers binding has no interactive multi-statement transaction —
   * only prepare/bind/run per statement, or batch() for a fixed statement
   * list decided up front. This runs the body sequentially: each statement
   * still commits individually and durably, but a failure partway through
   * does not roll back statements that already ran. Callers whose body does
   * a write-then-read-back that can throw (course creation is the proven
   * case) add their own compensating cleanup around this call — see
   * server/services/courses.js CourseService.create().
   */
  async transaction(fn) {
    return await fn();
  }

  async close() {}
}
