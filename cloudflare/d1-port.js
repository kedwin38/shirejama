// ── DatabasePort · adapter over D1 (ADR-001 / ADR-005 migration path) ────
// Same shape as server/core/db.js so every service/route file is shared,
// unmodified, between the Node server and this Worker.
export class D1Port {
  constructor(d1) {
    this.db = d1;
  }

  async exec(sql) {
    await this.db.exec(sql);
  }

  prepare(sql) {
    const stmt = this.db.prepare(sql);
    return {
      run: async (...p) => {
        const r = await stmt.bind(...p).run();
        return { changes: r.meta?.changes ?? 0, lastId: r.meta?.last_row_id ?? 0 };
      },
      get: async (...p) => (await stmt.bind(...p).first()) ?? null,
      all: async (...p) => (await stmt.bind(...p).all()).results ?? [],
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
