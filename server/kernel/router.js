// ── Minimal pattern router: METHOD /path/:param segments ────────────────
export class Router {
  constructor() {
    this.routes = [];
    this.middleware = [];
  }

  use(fn) { this.middleware.push(fn); return this; }

  _add(method, pattern, handler) {
    const segments = pattern.split('/').filter(Boolean).map((s) =>
      s.startsWith(':') ? { param: s.slice(1) } : { literal: s });
    this.routes.push({ method, segments, handler });
    return this;
  }

  get(p, h) { return this._add('GET', p, h); }
  post(p, h) { return this._add('POST', p, h); }
  put(p, h) { return this._add('PUT', p, h); }
  patch(p, h) { return this._add('PATCH', p, h); }
  delete(p, h) { return this._add('DELETE', p, h); }

  /** Returns handler + params, or null. HEAD falls back to GET. */
  match(method, pathName) {
    const parts = pathName.split('/').filter(Boolean).map(decodeURIComponent);
    outer:
    for (const r of this.routes) {
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      if (r.segments.length !== parts.length) continue;
      const params = {};
      for (let i = 0; i < parts.length; i++) {
        const seg = r.segments[i];
        if (seg.literal !== undefined && seg.literal !== parts[i]) continue outer;
        if (seg.param !== undefined) params[seg.param] = parts[i];
      }
      return { handler: r.handler, params };
    }
    return null;
  }
}
