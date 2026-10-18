# Shire Jama LMS 🕊️
### *“Education Without Limits” — Aqoon la'aan waa iftiin la'aan.*

A complete, role-based Learning Management System for the **Shire Jama'a Ahmed
Adult School**: administration, course authoring, media streaming, quizzing,
grading, and scheduled data protection — in **one Node.js process with zero
npm dependencies**.

![stack](https://img.shields.io/badge/node-%E2%89%A522.5-1E3A24) ![deps](https://img.shields.io/badge/dependencies-0-F2A712) ![tests](https://img.shields.io/badge/smoke--suite-67%2F67-2F7D46)

---

## Quick Start
```bash
node server/index.js          # that's the whole install
```
Open **http://localhost:3000**. First boot seeds the institution:


The demo course ships with a generated PDF worksheet, a streaming video
lecture, and a quiz (2 auto-graded MC + 1 manually-graded document task).
Set `SEED_DEMO=no` for a clean institution.

## What's Inside
- **Three portals, one gate** — role selection → username-or-email sign-in;
  accounts are always admin-provisioned (no self-registration).
- **Admin** — institution dashboard; provision teachers (`INST-10x`) and
  students (`STD-<year>-10xx`); edit/activate/reset/delete with safety guards
  (admins undeletable; teachers with courses must be reassigned first); the
  **Backup Console**.
- **Teacher** — Course Studio: chapters → PDF/video materials (magic-byte
  validated; streamed uploads to 2 GB; download toggle), quiz builder
  (timers, open/close windows, attempt caps, instant-results toggle,
  MC-with-image and document questions), submissions overview, per-question
  scoring and **result release**.
- **Student** — level-matched course shelf with completion rings; in-browser
  PDF reader and seekable video theater (**HTTP 206 range streaming**);
  chapter progress; focused quiz runner with live countdown, navigator,
  dual local+server autosave, typed and file-based answers; results history
  with full released breakdowns.
- **File vault** — every byte served through permission-checked endpoints:
  level-gated materials, owner-only answer files, UUID storage, no public URLs.
- **Backup engine (Strategy pattern)** — formats (SQLite snapshot / JSON dump)
  × targets (local disk; S3-ready interface) × scheduler; admin-configurable
  scope: Accounts / Results / Everything, with retention pruning.

## Architecture at a Glance
```
Node 24 · node:http + node:sqlite + node:crypto   (zero npm deps, zero supply chain)
Kernel (router/range-stream/static) → Services (domain logic) → Routes (thin)
SQLite WAL · scrypt sessions · streamed I/O everywhere · UTC-core, local-time UI
Frontier UI: seal-derived design system (ink green × seal gold × parchment),
Oswald/Inter/JBMono vendored offline, View Transitions, Ctrl+K palette,
day/dusk themes, WCAG-AA focus & contrast, reduced-motion support.
```
Full decision records: [`docs/02_ARCHITECTURE.md`](docs/02_ARCHITECTURE.md)

## Project Layout
```
server/            kernel · core · services · routes · schema.sql · seed
public/            SPA (ES modules, no build step) · design system · fonts
scripts/           smoke-test.js (67 assertions) · fetch-fonts.mjs (one-time)
docs/              SRS · architecture · data model · API spec · design
                   language · test report · deployment guide
data/              runtime: lms.db, uploads/, backups/  (created on boot)
```

## Commands
```bash
node server/index.js              # run
node scripts/smoke-test.js        # end-to-end API suite (server must be running)
node server/seed.js --run         # seed without starting the server
```

## Documentation
1. [Requirements (SRS)](docs/01_REQUIREMENTS.md)
2. [Architecture & ADRs](docs/02_ARCHITECTURE.md)
3. [Data Model](docs/03_DATA_MODEL.md)
4. [HTTP API Contract](docs/04_API_SPEC.md)
5. [UI/UX Design Language](docs/05_DESIGN_LANGUAGE.md)
6. [Test Report](docs/06_TESTING.md)
7. [Deployment & Operations](docs/07_DEPLOYMENT.md)

---
© Shire Jama'a Ahmed Adult School · Built with the rising sun and the open book. 📖🌅
