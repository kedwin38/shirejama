// ── Workers HTTP kernel: Response envelopes, cookies, R2 range streaming ─
// Fetch-API equivalent of server/kernel/http.js — same responsibilities,
// expressed as values (Response objects) instead of writeHead()/end() on a
// mutable res, since Workers' Response is immutable once constructed.
import { AppError } from '../server/core/errors.js';

export function jsonResponse(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

export function errorResponse(err, extraHeaders = {}) {
  const status = err instanceof AppError ? err.status : 500;
  const code = err instanceof AppError ? err.code : 'internal_error';
  const message = err instanceof AppError ? err.message
    : 'An unexpected error occurred. The incident has been logged.';
  if (status >= 500) {
    console.error(JSON.stringify({
      t: new Date().toISOString(), lvl: 'error', event: 'http_500',
      message: err?.message, stack: err?.stack?.split('\n').slice(0, 4),
    }));
  }
  return jsonResponse(status, { error: { code, message, details: err?.details } }, extraHeaders);
}

/** Buffered JSON body with hard cap. */
export async function readJsonBody(req, limitBytes) {
  const len = Number(req.headers.get('content-length') || 0);
  if (len > limitBytes) throw new AppError(413, 'payload_too_large', 'Request body exceeds the allowed size.');
  const text = await req.text();
  if (Buffer.byteLength(text) > limitBytes) {
    throw new AppError(413, 'payload_too_large', 'Request body exceeds the allowed size.');
  }
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { throw new AppError(400, 'bad_request', 'Request body must be valid JSON.'); }
}

// ── Cookies ──────────────────────────────────────────────────────────────
export function parseCookies(req) {
  const out = {};
  const raw = req.headers.get('cookie');
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookieHeader(name, value, { maxAgeSeconds, httpOnly = true, path = '/', sameSite = 'Strict' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (maxAgeSeconds != null) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

// ── Range parsing (single range; RFC 7233) — same semantics as Node kernel
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') {
    const n = parseInt(m[2], 10);
    if (n === 0) return { satisfiable: false };
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start > end || start >= size) return { satisfiable: false };
  return { start, end, satisfiable: true };
}

/**
 * Serves an R2 object with authorization already done by the caller.
 * Honors Range (206) for instant video seek/scrub, same contract as the
 * Node kernel's serveStoredFile — `path` here is an R2 object key.
 */
export async function serveR2Object(req, bucket, { path, mime, fileName, size, download = false }) {
  const head = await bucket.head(path);
  if (!head) return errorResponse(new AppError(404, 'not_found', 'The stored file is no longer available.'));
  const total = size || head.size;

  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${(fileName || 'file').replace(/["\\\r\n]/g, '_')}"`,
  };

  const rangeHeader = req.headers.get('range');
  const range = rangeHeader ? parseRange(rangeHeader, total) : null;
  if (rangeHeader && range && range.satisfiable === false) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
  }

  if (req.method === 'HEAD') {
    headers['Content-Length'] = String(total);
    return new Response(null, { status: 200, headers });
  }

  let obj;
  if (range) {
    obj = await bucket.get(path, { range: { offset: range.start, length: range.end - range.start + 1 } });
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${total}`;
    headers['Content-Length'] = String(range.end - range.start + 1);
    if (!obj) return errorResponse(new AppError(404, 'not_found', 'The stored file is no longer available.'));
    return new Response(obj.body, { status: 206, headers });
  }
  obj = await bucket.get(path);
  if (!obj) return errorResponse(new AppError(404, 'not_found', 'The stored file is no longer available.'));
  headers['Content-Length'] = String(total);
  return new Response(obj.body, { status: 200, headers });
}
