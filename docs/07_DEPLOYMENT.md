# Shire Jama LMS — Deployment & Operations Guide
The entire platform is **one Node.js process with zero npm dependencies**
(Node ≥ 22.5 required; built and verified on Node 24). Nothing to install,
nothing to build.

## 1 · Quick Start (any OS)
```bash
cd "F:\SHIRE-JAMA LMS"        # project root
node server/index.js          # listens on 0.0.0.0:3000
```
Open http://localhost:3000 — seed accounts are created on first boot
(see README). To change the admin password for go-live:
```bash
ADMIN_PASSWORD="YourStrong@Pass1" node server/index.js
```

## 2 · Configuration (environment variables)
| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `<project>/data` | DB, uploads, staging, backups root — **put this on persistent storage** |
| `SESSION_TTL_HOURS` | `8` | Sliding session lifetime |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / `Admin@Shire2026` | First-boot admin seed |
| `SEED_DEMO` | `yes` | Set `no` to skip the demo course/teacher/student |
| `LOG_REQUESTS` | `yes` | JSON request logs |

## 3 · Production Topology
```
Internet ── Caddy/Nginx (TLS) ──► Node LMS :3000
                                   ├── data/lms.db        (SQLite WAL)
                                   ├── data/uploads/**    (immutable UUID blobs)
                                   └── data/backups/**    (admin console artifacts)
```
- **TLS is mandatory** (cookies, credentials, coursework). Caddy example:
  `lms.shirejama.school { reverse_proxy 127.0.0.1:3000 }`
- **Process keep-alive:** PM2 (`pm2 start server/index.js --name shirejama-lms`),
  Windows Service via `node --experimental-windows-hide`, or systemd:
  ```ini
  [Service]
  WorkingDirectory=/opt/shirejama-lms
  ExecStart=/usr/bin/node server/index.js
  Restart=always
  Environment=ADMIN_PASSWORD=…
  ```
- **Vertical scale** is the first lever: a single process + SQLite WAL serves
  hundreds of concurrent users; media streaming is zero-copy `createReadStream`
  with 64 KB buffering, so a 2 GB lecture costs the server a pipe, not memory.
- **Scale-out:** run N identical processes behind the LB sharing `DATA_DIR` on a
  volume (WAL + `busy_timeout` handle multi-process contention); sessions are
  DB-backed so no sticky sessions are required.
- **Growth path (documented, no code change):** swap `DatabasePort` to
  PostgreSQL, plug an S3-compatible `BackupTarget`/FileVault backend — both are
  interfaces by design (ADR-005).

## 4 · Data & Backups
- Admin console → **Backup Console**: schedule (off/6h/daily/weekly), scope
  (Accounts / Results / Everything), format (SQLite snapshot via `VACUUM INTO`
  — online & consistent — or JSON dump), retention, manual run, download.
- Snapshots are consistent while the school is live; downloads are admin-only.
- **Off-site copy:** download backups regularly, or rsync `data/backups/` +
  `data/lms.db*` to another machine. Restoring a snapshot = stop server,
  replace `data/lms.db` (delete `-wal`/`-shm`), start server.
- Full disaster recovery = `data/` directory + this codebase. Nothing else exists.

## 5 · Operations Notes
- **Uploading:** streamed to disk with caps (PDF 100 MB · video 2 GB ·
  question files 5/50 MB · answer files 25 MB); magic-byte validated.
- **Clock:** all times stored UTC; quiz windows render in each user's local
  timezone. Keep the host clock NTP-synced (timed quizzes depend on it).
- **Log rotation:** stdout JSON lines → pipe to your logger of choice.
- **Security posture:** scrypt password hashes; HttpOnly+SameSite=Strict
  cookies; custom-header CSRF defense; per-role and per-object authorization on
  every route; permission-checked media endpoints; rate-limited sign-in.
- **Deactivated accounts** keep their data but cannot sign in (existing
  sessions die instantly). Deleting a student cascades their attempts/progress;
  deleting a teacher requires course-less state — by design.

## 6 · Health & Monitoring
`GET /api/health` → `{ok, uptime_s, time}` — wire to uptime monitors.
Structured events in logs: `server_listening`, `backup_completed`,
`backup_failed`, `backup_scheduled_run`, `http`, `http_err`, `http_500`.
