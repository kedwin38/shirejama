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
import { migrate, pendingMigrations } from '../server/core/migrate.js';

import { UserService } from '../server/services/users.js';
import { CourseService } from '../server/services/courses.js';
import { QuizService } from '../server/services/quizzes.js';
import { AttemptService } from '../server/services/attempts.js';
import { GradingService } from '../server/services/grading.js';
import { CatalogService } from '../server/services/catalog.js';
import { AnalyticsService } from '../server/services/analytics.js';
import { BackupEngine } from '../server/services/backups.js';
import { seedAdmin } from '../server/seed.js';

import { registerAuthRoutes } from '../server/routes/auth.routes.js';
import { registerAdminRoutes } from '../server/routes/admin.routes.js';
import { registerTeacherRoutes } from '../server/routes/teacher.routes.js';
import { registerStudentRoutes } from '../server/routes/student.routes.js';
import { registerFileRoutes } from '../server/routes/files.routes.js';

import { D1Port } from './d1-port.js';
import { R2Vault } from './r2-vault.js';
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
  services.backups = new BackupEngine(db);

  const router = new Router();
  const ctx = {
    db, config, sessions, services,
    limiter: new RateLimiter({ windowMs: 60_000, max: 20 }),
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
  // Schema migrations first (idempotent), then the admin seed.
  try {
    const pending = await pendingMigrations(w.db);
    if (pending.length) {
      await migrate(w.db);
      log.info('db_migrated', { applied: pending });
    }
  } catch (e) {
    log.error('db_migration_failed', { err: e.message });
  }
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

/** Origin for absolute SEO URLs (custom domain first, workers.dev fallback). */
const SEO_ORIGIN = 'https://shirejamaschools.com';

/**
 * Subliminal SEO layer — crawler-facing routes served by the Worker with
 * correct content types. Everything else stays on Workers Assets.
 *  · /robots.txt  — crawl contract: public shell indexable, API + gate excluded
 *  · /sitemap.xml — dynamic: public pages now, published-course catalog later
 *                   (lastmod reflects the newest content change in D1)
 */
function seoRoutes(pathName) {
  if (pathName === '/robots.txt') {
    const body = `# Shire Jama'a Ahmed Adult School — crawler contract\n` +
      `User-agent: *\n` +
      `Allow: /\n` +
      `Disallow: /api/\n` +
      `\n` +
      `Sitemap: ${SEO_ORIGIN}/sitemap.xml\n`;
    return new Response(body, { headers: { 'content-type': 'text/plain;charset=utf-8', 'cache-control': 'public, max-age=3600' } });
  }
  if (pathName === '/sitemap.xml') {
    const today = new Date().toISOString().slice(0, 10);
    const urls = [
      { loc: `${SEO_ORIGIN}/`, priority: '1.0', changefreq: 'weekly', lastmod: today },
      // Future: one entry per published course (/courses/<id>) — the
      // programmatic-SEO surface that grows with the school's catalog.
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      urls.map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n` +
        `    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`).join('\n') +
      `\n</urlset>\n`;
    return new Response(xml, { headers: { 'content-type': 'application/xml;charset=utf-8', 'cache-control': 'public, max-age=3600' } });
  }
  return null;
}

export default {
  async fetch(request, env, execCtx) {
    if (!wiring) {
      wiring = build(env);
      execCtx.waitUntil(ensureSeeded(wiring)); // once per cold start, not per request
    }

    const url = new URL(request.url);

    // Crawler-facing SEO routes (served before assets so they never fall
    // through to the SPA fallback, which would poison them with HTML).
    const seo = seoRoutes(url.pathname);
    if (seo) return seo;

    if (!url.pathname.startsWith('/api/')) {
      // The frontend is a hash-router SPA (routes live in location.hash,
      // which the server never sees) — served by Workers Assets with SPA
      // fallback (wrangler.toml [assets]); static requests are free and
      // unlimited and never invoke this Worker.
      return env.ASSETS.fetch(request);
    }
    const res = await handleApi(request, env, url.pathname);
    // The API is private machinery — keep it out of the index entirely.
    res.headers.set('X-Robots-Tag', 'noindex, nofollow');
    return res;
  },

  // Cron trigger (every 30 minutes) — Workers has no persistent setInterval
  // between requests, so the backup policy tick runs here instead.
  async scheduled(event, env, execCtx) {
    if (!wiring) wiring = build(env);
    execCtx.waitUntil(wiring.backupEngine.tick());
  },
};
