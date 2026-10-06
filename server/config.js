// ── Shire Jama LMS · central configuration ──────────────────────────────
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const LEVELS = Object.freeze([
  'C1','C2','C3','C4','C5','C6','C7','C8','F1','F2','F3','F4',
]);
export const LEVEL_LABELS = Object.freeze(
  Object.fromEntries(LEVELS.map((l) => [
    l,
    l.startsWith('C') ? `Class ${l.slice(1)}` : `Form ${l.slice(1)}`,
  ])),
);

const config = {
  root: ROOT,
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || join(ROOT, 'data'),
  publicDir: join(ROOT, 'public'),
  serverAssets: join(ROOT, 'server', 'assets'),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 8),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'Admin@Shire2026',
  seedDemo: process.env.SEED_DEMO !== 'no',
  logRequests: process.env.LOG_REQUESTS !== 'no',

  // Upload caps (bytes): streamed to disk, never buffered in RAM.
  caps: {
    materialPdf: 100 * 1024 * 1024,        // 100 MB
    materialVideo: 2 * 1024 * 1024 * 1024, // 2 GB
    questionImage: 5 * 1024 * 1024,        // 5 MB
    questionAttachment: 50 * 1024 * 1024,  // 50 MB
    answerFile: 25 * 1024 * 1024,          // 25 MB
    jsonBody: 2 * 1024 * 1024,             // 2 MB for JSON APIs
  },

  // Uploaded answer-file kinds (FR-5.6)
  answerMimes: new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png', 'image/jpeg', 'image/webp',
  ]),
};

config.dbFile = join(config.dataDir, 'lms.db');
config.uploadsDir = join(config.dataDir, 'uploads');
config.stagingDir = join(config.dataDir, 'staging');
config.backupsDir = join(config.dataDir, 'backups');
config.subDirs = {
  materials: join(config.uploadsDir, 'materials'),
  questions: join(config.uploadsDir, 'questions'),
  answers: join(config.uploadsDir, 'answers'),
};

export default config;
