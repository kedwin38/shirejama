// ── Sliding-window rate limiter (auth hardening, NFR-4) ─────────────────
// In-process by design; the documented scale-out path swaps this port for a
// shared store (e.g. the DB or Redis) without touching call sites.
export class RateLimiter {
  constructor({ windowMs = 60_000, max = 10 } = {}) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
  }

  check(key) {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) { // crude memory guard
      for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
    }
    return true;
  }
}
