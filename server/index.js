// ── Shire Jama LMS · server entry point ──────────────────────────────────
// Zero-dependency Node 24 server (docs/02_ARCHITECTURE.md).
import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import config from './config.js';
import { DatabasePort } from './core/db.js';
import { SessionStore } from './core/auth.js';
import { RateLimiter } from './core/ratelimit.js';
import { log } from './core/log.js';
import { AppError } from './core/errors.js';
import { Router } from './kernel/router.js';
import { sendJson, sendError, readJsonBody, parseCookies, setCookie, serveStoredFile } from './kernel/http.js';
import { serveStatic, sendStatic } from './kernel/static.js';

import { FileVault } from './services/files.js';
import { UserService } from './services/users.js';
import { CourseService } from './services/courses.js';
import { QuizService } from './services/quizzes.js';
import { AttemptService } from './services/attempts.js';
import { GradingService } from './services/grading.js';
import { CatalogService } from './services/catalog.js';
import { AnalyticsService } from './services/analytics.js';
import { BackupEngine } from './services/backups.js';

import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerAdminRoutes } from './routes/admin.routes.js';
import { registerTeacherRoutes } from './routes/teacher.routes.js';
import { registerStudentRoutes } from './routes/student.routes.js';
import { registerFileRoutes } from './routes/files.routes.js';
import { seedAdmin } from './seed.js';
import { seedDemo } from './seed-demo-node.js';

// ── Bootstrap storage ─────────────────────────────────────────────────────
for (const dir of [config.dataDir, config.stagingDir, config.backupsDir,
                   ...Object.values(config.subDirs)]) {
  mkdirSync(dir, { recursive: true });
}

const db = new DatabasePort(config.dbFile);
db.exec(readFileSync(join(config.root, 'server', 'schema.sql'), 'utf8'));

const sessions = new SessionStore(db, config.sessionTtlHours);
await sessions.purgeExpired();
const vault = new FileVault(db, config);
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

const backupEngine = new BackupEngine(db, config.dbFile);
services.backups = backupEngine;

const router = new Router();
const ctx = {
  db, config, sessions, services,
  limiter: new RateLimiter({ windowMs: 60_000, max: 20 }),
  setSessionCookie: (res, token) => setCookie(res, 'sid', token, {
    maxAgeSeconds: config.sessionTtlHours * 3600,
  }),
  clearSessionCookie: (res) => setCookie(res, 'sid', '', { maxAgeSeconds: 0 }),
  serveFile: async (req, res, descriptor) => serveStoredFile(req, res, descriptor),
};
registerAuthRoutes(router, ctx);
registerAdminRoutes(router, ctx);
registerTeacherRoutes(router, ctx);
registerStudentRoutes(router, ctx);
registerFileRoutes(router, ctx);
router.get('/api/health', () => ({ ok: true, uptime_s: Math.round(process.uptime()), time: new Date().toISOString() }));

// ── Seed (idempotent) ─────────────────────────────────────────────────────
const { admin, created } = await seedAdmin(db);
if (created) log.info('admin_seeded', { username: admin.username });
if (config.seedDemo) {
  const r = await seedDemo(db);
  if (r.seeded) log.info('demo_seeded', { teacher: 'hodan.abdi', student: 'amina.yusuf' });
}

// ── Request dispatcher ────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { res.writeHead(400).end(); return; }
  const pathName = url.pathname;

  // Baseline security headers on every response.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // API freshness is owned by the client-side cache — keep the HTTP cache
  // out of it so the two layers can never disagree.
  if (pathName.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');

  try {
    if (pathName.startsWith('/api/')) {
      // CSRF defense-in-depth: state changes require our custom header
      // (browsers won't let foreign origins set it without a CORS
      // preflight, which this server never approves).
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
          && req.headers['x-requested-with'] !== 'fetch') {
        throw new AppError(403, 'forbidden', 'Missing anti-CSRF header.');
      }

      // Session resolution (sliding).
      const cookies = parseCookies(req);
      const token = cookies.sid || null;
      let user = token ? await sessions.resolve(token) : null;
      if (user && token) await sessions.touch(token);

      const match = router.match(req.method, pathName);
      if (!match) throw new AppError(404, 'not_found', `No such endpoint: ${req.method} ${pathName}`);

      const query = Object.fromEntries(url.searchParams.entries());
      let body = undefined;
      const isJson = (req.headers['content-type'] || '').includes('application/json');
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && isJson) {
        body = await readJsonBody(req, config.caps.jsonBody);
      }

      const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').trim();
      // Background task lane — Worker parity (there it maps to waitUntil).
      const cctx = { params: match.params, query, body, user, token, ip,
        defer: (p) => { p?.catch?.(() => {}); } };

      const result = await match.handler(req, res, cctx);
      // Handlers that stream files write their own response (headers already
      // sent); only fall back to the JSON envelope when nothing was written.
      if (!res.headersSent && !res.writableEnded) sendJson(res, 200, result ?? { ok: true });
      if (config.logRequests) log.info('http', {
        method: req.method, path: pathName, status: res.statusCode,
        ms: Date.now() - started, user: user?.username ?? null,
      });
      return;
    }

    // Static SPA
    const file = serveStatic(config.publicDir, pathName);
    if (file) { sendStatic(req, res, file); return; }
    sendError(res, new AppError(404, 'not_found', 'Not found.'));
  } catch (err) {
    if (!res.headersSent) sendError(res, err);
    else res.destroy();
    if (config.logRequests) log.warn('http_err', {
      method: req.method, path: pathName, status: err?.status || 500, ms: Date.now() - started,
    });
  }
});

// ── Scheduler + lifecycle ─────────────────────────────────────────────────
// Cron parity with the Worker's scheduled handler: the engine's tick
// respects the off-by-default policy and the configured frequency.
const scheduler = setInterval(() => backupEngine.tick().catch(() => {}), 30 * 60_000);
scheduler.unref();

server.listen(config.port, config.host, () => {
  log.info('server_listening', {
    host: config.host, port: config.port,
    data: config.dataDir, node: process.version,
  });
});

const shutdown = (signal) => {
  log.info('shutdown', { signal });
  clearInterval(scheduler);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
