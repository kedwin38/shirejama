// ── Static asset serving (public/) with safe path handling ───────────────
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { MIME } from './http.js';

/**
 * Serves /assets/* and the SPA shell. Paths are normalized and constrained
 * to the public root — traversal is impossible by construction (FR-6.4).
 */
export function serveStatic(publicDir, url) {
  let rel = decodeURIComponent(url.split('?')[0]);
  if (rel.includes('\0')) return null;
  if (rel === '/' || rel === '') rel = '/index.html';
  if (!/\.[a-zA-Z0-9]+$/.test(rel)) rel = '/index.html'; // SPA fallback (hash routing)
  const base = normalize(publicDir);
  const target = normalize(join(base, rel));
  if (target !== base && !target.startsWith(base + sep)) return null;

  let stats;
  try { stats = statSync(target); } catch { return null; }
  if (!stats.isFile()) return null;

  const ext = extname(target).toLowerCase();
  return {
    path: target,
    mime: MIME[ext] || 'application/octet-stream',
    size: stats.size,
    immutableAsset: rel.startsWith('/assets/'),
  };
}

export function sendStatic(req, res, file) {
  const headers = {
    'Content-Type': file.mime,
    'Content-Length': String(file.size),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': file.immutableAsset
      ? 'public, max-age=86400'
      : 'no-cache',
  };
  // Conditional request support keeps repeat loads cheap worldwide.
  const etag = `"${file.size}-${Math.floor(file.mtimeMs || 0)}"`;
  headers['ETag'] = etag;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  const stream = createReadStream(file.path);
  stream.on('error', () => res.destroy());
  req.on('close', () => stream.destroy());
  stream.pipe(res);
}
