// ── API client: cookie session + anti-CSRF header + typed errors ─────────
// Requests cost money at scale, navigation shouldn't: GET responses are
// held for a short TTL (and in-flight GETs are shared), while ANY successful
// mutation wipes the cache so writes always read back fresh data.

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 200;
const cache = new Map(); // path -> { expires, data?, promise? }

// Older mobile browsers (pre-15.4 Safari, old Android WebViews) lack
// structuredClone — JSON round-trip is a fine fallback for API payloads.
const cloneData = (d) => (typeof structuredClone === 'function' ? structuredClone(d) : JSON.parse(JSON.stringify(d)));

function cacheLookup(path) {
  const entry = cache.get(path);
  if (!entry) return null;
  if (Date.now() > entry.expires) { cache.delete(path); return null; }
  return entry;
}

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}

async function request(method, path, { body, raw = false, timeoutMs = 45000, fresh = false } = {}) {
  // Cached GET: repeated navigation reuses the answer instead of re-asking.
  if (method === 'GET' && !fresh) {
    const entry = cacheLookup(path);
    if (entry?.data !== undefined) return cloneData(entry.data);
    if (entry?.promise) return entry.promise.then((d) => cloneData(d));
  }
  const headers = { 'X-Requested-With': 'fetch' };
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  let res;
  const flight = (async () => {
    try {
      res = await fetch(path, {
        method,
        headers,
        credentials: 'same-origin',
        body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // A hung request must never hang the user — turn it into a clear error
      // they can act on (retry), instead of an endless spinner.
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
        throw new ApiError(0, 'timeout',
          'The server took too long to respond — please check your connection and try again.');
      }
      throw new ApiError(0, 'network', 'Could not reach the server — check your internet connection and try again.');
    }
    let data = {};
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) { try { data = await res.json(); } catch {} }
    if (!res.ok) {
      if (res.status === 401 && !path.startsWith('/api/auth/')) {
        window.dispatchEvent(new CustomEvent('api:unauthorized'));
      }
      throw new ApiError(res.status, data?.error?.code, data?.error?.message || res.statusText, data?.error?.details);
    }
    return data;
  })();

  if (method === 'GET' && !fresh) {
    // Register the flight for dedup; swap in the result once it lands.
    cache.set(path, { expires: Date.now() + CACHE_TTL_MS, promise: flight });
    try {
      const data = await flight;
      cache.set(path, { expires: Date.now() + CACHE_TTL_MS, data });
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return cloneData(data);
    } catch (e) {
      if (cache.get(path)?.promise === flight) cache.delete(path);
      throw e;
    }
  }
  const data = await flight;
  if (method !== 'GET') cache.clear(); // a write happened — nothing is stale-tolerant anymore
  return data;
}

export const api = {
  get: (p, opts) => request('GET', p, opts),
  post: (p, body = {}) => request('POST', p, { body }),
  put: (p, body = {}) => request('PUT', p, { body }),
  patch: (p, body = {}) => request('PATCH', p, { body }),
  delete: (p) => request('DELETE', p),
};
