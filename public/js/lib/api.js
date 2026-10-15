// ── API client: cookie session + anti-CSRF header + typed errors ─────────
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}

async function request(method, path, { body, raw = false, timeoutMs = 45000 } = {}) {
  const headers = { 'X-Requested-With': 'fetch' };
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
  let res;
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
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, body = {}) => request('POST', p, { body }),
  put: (p, body = {}) => request('PUT', p, { body }),
  patch: (p, body = {}) => request('PATCH', p, { body }),
  delete: (p) => request('DELETE', p),
};
