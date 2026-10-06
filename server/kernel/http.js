// ── HTTP kernel primitives: envelopes, bodies, cookies, range streaming ──
import { createReadStream, statSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { unlinkSync } from 'node:fs';
import { AppError } from '../core/errors.js';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v', '.ogg': 'video/ogg',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.jpeg_large': 'image/jpeg',
};

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendError(res, err) {
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
  sendJson(res, status, { error: { code, message, details: err?.details } });
}

/** Buffered JSON body with hard cap. */
export function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > limitBytes) {
      reject(new AppError(413, 'payload_too_large', 'Request body exceeds the allowed size.'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new AppError(413, 'payload_too_large', 'Request body exceeds the allowed size.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new AppError(400, 'bad_request', 'Request body must be valid JSON.')); }
    });
    req.on('error', () => reject(new AppError(400, 'bad_request', 'Failed to read request body.')));
  });
}

/**
 * Streams a raw request body straight to disk — never buffered in RAM, so a
 * 2 GB lecture video costs the server a pipe, not memory (NFR-1 / ADR-003).
 */
export function readRawBodyToFile(req, destPath, capBytes) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > capBytes) {
      reject(new AppError(413, 'payload_too_large',
        `File exceeds the maximum permitted size of ${Math.floor(capBytes / 1024 / 1024)} MB.`));
      req.resume();
      return;
    }
    const out = createWriteStream(destPath, { flags: 'wx' });
    let size = 0;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      out.destroy();
      try { unlinkSync(destPath); } catch { /* already gone */ }
      reject(err);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > capBytes) {
        fail(new AppError(413, 'payload_too_large',
          `File exceeds the maximum permitted size of ${Math.floor(capBytes / 1024 / 1024)} MB.`));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (settled) return;
      out.end(() => { if (!settled) { settled = true; resolve({ size }); } });
    });
    req.on('error', (e) => fail(new AppError(400, 'bad_request', `Upload failed: ${e.message}`)));
    out.on('error', (e) => fail(new AppError(500, 'internal_error', `Could not store upload: ${e.message}`)));
    req.pipe(out);
  });
}

// ── Cookies ──────────────────────────────────────────────────────────────
export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, { maxAgeSeconds, httpOnly = true, path = '/', sameSite = 'Strict' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (maxAgeSeconds != null) parts.push(`Max-Age=${maxAgeSeconds}`);
  const prev = res.getHeader('Set-Cookie');
  const cookie = parts.join('; ');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, cookie) : cookie);
}

// ── Range parsing (single range; RFC 7233) ───────────────────────────────
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null; // ignore multi-range → 200
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
 * Serves a stored file with authorization already done by the caller.
 * Honors Range (206) for instant video seek/scrub; aborts the read stream
 * when the client disconnects so a scrubbed-away request never leaks I/O.
 */
export function serveStoredFile(req, res, { path, mime, fileName, size, download = false }) {
  let stats;
  try { stats = statSync(path); } catch {
    sendError(res, new AppError(404, 'not_found', 'The stored file is no longer available.'));
    return;
  }
  const total = stats.size;
  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${(fileName || 'file').replace(/["\\\r\n]/g, '_')}"`,
  };

  const rangeHeader = req.headers.range;
  const range = rangeHeader ? parseRange(rangeHeader, total) : null;
  if (rangeHeader && range && range.satisfiable === false) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    res.end();
    return;
  }

  let start = 0, end = total - 1, status = 200;
  if (range) {
    start = range.start; end = range.end; status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
  }
  headers['Content-Length'] = String(end - start + 1);

  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return; }

  const stream = createReadStream(path, { start, end });
  stream.on('error', () => res.destroy());
  req.on('close', () => stream.destroy());
  stream.pipe(res);
}
