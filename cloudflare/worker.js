// ── Shire Jama LMS · Cloudflare Worker entry point ───────────────────────
// Same router, services, and route modules as server/index.js (Node) — only
// the kernel underneath differs: D1 instead of node:sqlite, R2 instead of
// local disk, Request/Response instead of node:http.
import config from '../server/config.js';
import { AppError } from '../server/core/errors.js';
import { Router } from '../server/kernel/router.js';
import { SessionStore, requireAuth } from '../server/core/auth.js';
import { RateLimiter } from '../server/core/ratelimit.js';
import { log } from '../server/core/log.js';

import { UserService } from '../server/services/users.js';
import { CourseService } from '../server/services/courses.js';
import { QuizService } from '../server/services/quizzes.js';
import { AttemptService } from '../server/services/attempts.js';
import { GradingService } from '../server/services/grading.js';
import { CatalogService } from '../server/services/catalog.js';
import { AnalyticsService } from '../server/services/analytics.js';
import { BackupEngine, BackupFormat, JSONDumpFormat } from '../server/services/backups.js';
import { seedAdmin } from '../server/seed.js';

import { registerAuthRoutes } from '../server/routes/auth.routes.js';
import { registerAdminRoutes } from '../server/routes/admin.routes.js';
import { registerTeacherRoutes } from '../server/routes/teacher.routes.js';
import { registerStudentRoutes } from '../server/routes/student.routes.js';
import { registerFileRoutes } from '../server/routes/files.routes.js';

import { D1Port } from './d1-port.js';
import { R2Vault } from './r2-vault.js';
import { R2BackupTarget } from './r2-backup-target.js';
import { jsonResponse, errorResponse, readJsonBody, parseCookies, cookieHeader, serveR2Object } from './kernel-http.js';

let wiring = null; // built lazily on first request, reused across the isolate's lifetime

function build(env) {
  const db = new D1Port(env.DB);
  const sessions = new SessionStore(db, config.sessionTtlHours);
  const vault = new R2Vault(db, env.MEDIA, config.caps);
  const services = {
    users: new UserService(db),
    courses: new CourseService(db, vault),
    quizzes: new QuizService(db, vault),
    attempts: new AttemptService(db, vault),
    grading: new GradingService(db),
    catalog: new CatalogService(db),
    analytics: new AnalyticsService(db),
    vault,
  };
  services.backups = new BackupEngine(db, null, {
    target: new R2BackupTarget(env.MEDIA),
    formats: [new JSONDumpFormat()],
  });

  const router = new Router();
  const ctx = {
    db, config, sessions, services,
    limiter: new RateLimiter({ windowMs: 60_000, max: 12 }),
    setSessionCookie: (res, token) => res?.cookies?.push(
      cookieHeader('sid', token, { maxAgeSeconds: config.sessionTtlHours * 3600 })),
    clearSessionCookie: (res) => res?.cookies?.push(cookieHeader('sid', '', { maxAgeSeconds: 0 })),
    serveFile: async (req, _res, descriptor) => serveR2Object(req, env.MEDIA, descriptor),
  };
  registerAuthRoutes(router, ctx);
  registerAdminRoutes(router, ctx);
  registerTeacherRoutes(router, ctx);
  registerStudentRoutes(router, ctx);
  registerFileRoutes(router, ctx);
  router.get('/api/health', () => ({ ok: true, runtime: 'cloudflare-workers', time: new Date().toISOString() }));

  return { db, sessions, services, router, ctx, backupEngine: services.backups };
}

async function ensureSeeded(w) {
  const { admin, created } = await seedAdmin(w.db);
  if (created) log.info('admin_seeded', { username: admin.username });
}

async function handleApi(request, env, pathName) {
  const w = wiring;
  const started = Date.now();
  try {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)
        && request.headers.get('x-requested-with') !== 'fetch') {
      throw new AppError(403, 'forbidden', 'Missing anti-CSRF header.');
    }

    const cookies = parseCookies(request);
    const token = cookies.sid || null;
    let user = token ? await w.sessions.resolve(token) : null;
    if (user && token) await w.sessions.touch(token);

    const match = w.router.match(request.method, pathName);
    if (!match) throw new AppError(404, 'not_found', `No such endpoint: ${request.method} ${pathName}`);

    const url = new URL(request.url);
    const query = Object.fromEntries(url.searchParams.entries());
    let body;
    const isJson = (request.headers.get('content-type') || '').includes('application/json');
    if (['POST', 'PUT', 'PATCH'].includes(request.method) && isJson) {
      body = await readJsonBody(request, config.caps.jsonBody);
    }
    const ip = request.headers.get('cf-connecting-ip') || '';
    const cctx = { params: match.params, query, body, user, token, ip };

    const res = { cookies: [] };
    const result = await match.handler(request, res, cctx);

    const response = result instanceof Response ? result : jsonResponse(200, result ?? { ok: true });
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'same-origin');
    headers.set('X-Frame-Options', 'SAMEORIGIN');
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    for (const c of res.cookies) headers.append('Set-Cookie', c);
    log.info('http', { method: request.method, path: pathName, status: response.status,
      ms: Date.now() - started, user: user?.username ?? null });
    return new Response(response.body, { status: response.status, headers });
  } catch (err) {
    log.warn('http_err', { method: request.method, path: pathName,
      status: err?.status || 500, ms: Date.now() - started });
    return errorResponse(err);
  }
}

export default {
  async fetch(request, env, execCtx) {
    if (!wiring) {
      wiring = build(env);
      execCtx.waitUntil(ensureSeeded(wiring)); // once per cold start, not per request
    }

    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      // The frontend is a hash-router SPA (routes live in location.hash,
      // which the server never sees) — served by Workers Assets with SPA
      // fallback (wrangler.toml [assets]); static requests are free and
      // unlimited and never invoke this Worker.
      return env.ASSETS.fetch(request);
    }
    return await handleApi(request, env, url.pathname);
  },

  // Cron trigger (every 30 minutes) — Workers has no persistent setInterval
  // between requests, so the backup scheduler's tick runs here instead.
  async scheduled(event, env, execCtx) {
    if (!wiring) wiring = build(env);
    const cfg = await wiring.backupEngine.config();
    const FREQUENCIES = { off: 0, '6h': 6 * 3600e3, daily: 24 * 3600e3, weekly: 7 * 24 * 3600e3 };
    if (!cfg.enabled || !FREQUENCIES[cfg.frequency]) return;
    const next = cfg.next_run ? Date.parse(cfg.next_run) : 0;
    if (next && Date.now() < next) return;
    log.info('backup_scheduled_run', { scope: cfg.scope, format: cfg.format });
    try {
      await wiring.backupEngine.run({});
    } finally {
      const freq = FREQUENCIES[cfg.frequency];
      await wiring.backupEngine._cfgSet('next_run', freq ? new Date(Date.now() + freq).toISOString() : '');
    }
  },
};
