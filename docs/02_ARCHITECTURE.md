# Shire Jama LMS — Architecture Document
Version 1.0 · 2026-10-06

## 1. Guiding Decisions (ADR Summary)

### ADR-001 — Runtime: Node.js 24, zero runtime npm dependencies
**Decision:** The entire backend runs on Node's built-in modules only: `node:http`,
`node:sqlite`, `node:crypto`, `node:fs`, `node:path`, `node:stream`.
**Rationale:**
- **Zero supply-chain surface** — nothing to install, no CVE feed to track, `node server/index.js` is the entire deploy step.
- `node:sqlite` (SQLite 3.53, WAL) is embedded, transactional, and for this
  institution's scale (hundreds–thousands of concurrent users) is measurably
  faster than a networked RDBMS for point reads, while WAL allows concurrent
  readers alongside a single writer.
- Node's streaming I/O is ideal for the media profile of an LMS (video byte-range
  serving, large streamed uploads) — see ADR-003.
**Consequences:** a thin `DatabasePort` adapter isolates SQL dialect; the documented
migration path is PostgreSQL behind the same port (see §5).

### ADR-002 — Frontend: framework-free ES-module SPA, vendor-locked assets
**Decision:** Hand-rolled hash-router SPA in native ES modules; all fonts/icons/patterns
served locally (no CDN at runtime).
**Rationale:** worldwide access includes regions with unreliable connectivity to
specific CDNs; a ~60 KB total payload beats any framework; full control of the
institutional design language. Progressive enhancement: View Transitions API,
`<dialog>`, `conic-gradient` rings, `Ctrl+K` palette.

### ADR-003 — Media: streamed serving with HTTP 206 partial content
**Decision:** `/api/files/*` endpoints map an opaque DB id → server-stored path,
enforce authorization, then stream with `Range` support (`206`, `Content-Range`,
`Accept-Ranges`) via `fs.createReadStream({start,end})`.
**Rationale:** instant seek/scrub for videos, resumable downloads, constant memory
(a 2 GB video streams through a 64 KB buffer). Uploads are raw `PUT` bodies streamed
straight to disk with a byte counter enforcing caps — multipart parsing avoided entirely.

### ADR-004 — Auth: server-side sessions in SQLite
**Decision:** 256-bit random tokens in `HttpOnly; SameSite=Strict` cookies; session
rows in the DB; 8h sliding expiry; destroy on logout.
**Rationale:** works across server restarts and across multiple app instances behind
a load balancer (no sticky sessions needed); revocable instantly (deactivate/delete).

### ADR-005 — Backups: Strategy pattern (formats × targets × scheduler)
**Decision:** `BackupFormat` implementations (`SQLiteSnapshotFormat` via `VACUUM INTO`,
`JSONDumpFormat` per-scope table export) write to a `BackupTarget`
(`LocalDiskTarget`; S3-compatible target is the documented extension point).
A `BackupScheduler` reads admin configuration from the DB and runs on an interval.
**Rationale:** the admin-facing console configures *policy*; the engine swallows
*mechanism* — new formats/targets are additive classes, no UI change.

## 2. System Topology

```
                       ┌────────────────────────────────────────────┐
   Browser (SPA)  ⇄ TLS⇐  Node HTTP Kernel (single process, xN)     │
   ES modules,          │  ├── Router (method+pattern, params)      │
   fetch/XHR,           │  ├── Security middleware (session, CSRF,  │
   <video>/<iframe>     │  │   rate limit, roles)                   │
                        │  ├── Service layer (domain logic)         │
                        │  ├── DatabasePort → node:sqlite (WAL)     │
                        │  └── FileVault (stream, range, magic)     │
                        └─────────────┬───────────────┬─────────────┘
                                      │               │
                              data/lms.db      data/uploads/**, data/backups/**
                              (SQLite WAL)     (UUID-named immutable blobs)
```
- **Scale-out:** N identical app processes on one host (or behind any LB) sharing
  `data/` on a volume; WAL permits multi-reader/single-writer across processes with
  `busy_timeout` retry.
- **Scale-up path:** `DatabasePort` swap to PostgreSQL + object storage target for
  FileVault/Backups — no route/UI changes.

## 3. Layering
```
server/
  index.js            boot, wiring, graceful shutdown
  config.js           env + constants (paths, caps, policy)
  kernel/             HTTP primitives (router, body, send, static, range)
  core/               db.js (DatabasePort), ids.js, passwords.js, auth.js,
                      errors.js, validate.js, ratelimit.js, log.js
  services/           users, courses, chapters, materials, quizzes,
                      attempts, grading, progress, files, backups
  routes/             auth, admin, teacher, student, files, backups, health
  seed.js             idempotent demo data (admin, teacher, student, course)
```
Rules: routes only parse/authorize/serialize; services own transactions;
kernel never imports services; core has no HTTP knowledge.

## 4. Key Algorithms
- **Attempt lifecycle:** `POST /student/quizzes/:id/start` — inside a transaction,
  revalidate window & attempts; if an `in_progress` attempt exists → resume it;
  else allocate `attempt_no = count+1` guarded by `UNIQUE(quiz,student,attempt_no)`.
  Submit flips `in_progress→submitted` (or `→released` when auto-gradable +
  show-immediately), scoring MC answers in the same transaction.
- **Scoring model:** `answer.score` per question; `auto_score = Σ MC scores`;
  `manual_total = Σ DOCUMENT scores` (teacher-entered); attempt `score =
  auto_score + manual_total`; `max_score = Σ question.points`. Status flow:
  `in_progress → submitted → graded → released` (auto-release shortcut allowed).
- **Grading completion:** an attempt becomes `graded` when every DOCUMENT answer
  has a non-null score; release is an explicit teacher action.
- **Video range serving:** parse single `Range: bytes=a-b` (and `a-` / suffix
  `-n`); clamp; respond 206 with exact `Content-Length`; abort streams on client
  disconnect (`req.on('close')`).
- **Magic-byte validation:** PDF `%PDF-`; MP4/MOV `....ftyp` + brand allowlist;
  WebM/MKV `1A 45 DF A3`; images PNG/JPEG/GIF/WebP signatures.
- **Sequenced IDs:** `INST-<n>` / `STD-<year>-<n>` derived from
  `MAX(numeric suffix)` per scope inside the creation transaction.

## 5. Deployment Notes (condensed; full guide in 07_DEPLOYMENT.md)
- Run `node server/index.js`; configurable via env (`PORT`, `DATA_DIR`,
  `ADMIN_PASSWORD`, `SESSION_TTL_HOURS`, seed toggle).
- Windows service / systemd / PM2 or container; reverse proxy (Caddy/Nginx) for TLS.
- Backups land in `data/backups` (downloadable from the console; copy off-host).

## 6. Testing Strategy
- `scripts/smoke-test.js` — black-box end-to-end API suite covering every FR
  (provision → author → upload (incl. fake-PDF rejection) → take quiz → grade →
  release → results → backups), asserts status codes + payloads.
- Browser-based GUI verification pass (screenshots of each portal).
- `node --check` syntax gates on all modules.
