# Shire Jama LMS — Test Report (v1.0)
Date: 2026-10-06 · Suite: `node scripts/smoke-test.js` · Target: black-box HTTP against a running server.

## 1 · Automated API Suite — **67 / 67 PASSED**

| # | Area | Coverage (assertions) |
|---|------|----------------------|
| 1 | Health & kernel | health endpoint; anti-CSRF header enforced on state changes |
| 2 | Authentication (FR-1) | wrong-password 401; role/portal mismatch 401; admin login sets HttpOnly session; `/me` resolves session |
| 3 | Provisioning (FR-3.1/3.2) | weak password 422 with policy details; teacher + auto `INST-10x`; student + auto `STD-<year>-10xx`; both sign in immediately; account search |
| 4 | Role boundaries | teacher→admin API blocked; student→teacher API blocked; anonymous 401 |
| 5 | Course authoring (FR-4.1/4.3) | course create; chapter add; level retag |
| 6 | Materials & validation (FR-4.4/4.5) | real PDF accepted; **Word-doc-renamed-.pdf rejected 415**; non-video container rejected 415 |
| 7 | Quiz authoring (FR-4.6/4.7) | quiz create; question image staged via token; MC question with image + 3 options; DOC question with attachment |
| 8 | Visibility (FR-2.3/5.1) | F2 student sees F2 course; F1 student does not |
| 9 | File vault (FR-6) | out-of-level student denied; in-level streams; anonymous denied; **Range → 206 Partial Content with exact Content-Range** |
| 10 | Quiz runtime (FR-5.5/5.6) | start; deadline present; **running payload never leaks `is_correct`**; autosave; answer-file upload; submit → DOC holds result (FR-4.8) |
| 11 | Answer privacy (FR-6.3) | other student 404; owner reads; owning teacher reads |
| 12 | Grading & release (FR-4.9/4.10) | submission listed; release blocked until scored; out-of-range score 400; score→graded; student blocked pre-release; release; **breakdown = 6/7 with correct answers**; history row |
| 13 | Windows & limits | 2nd attempt allowed; 3rd blocked by `max_attempts` 409 |
| 14 | Account guards (FR-3.4–3.7) | deactivate → session dead; re-activate; **teacher-with-courses delete blocked 409**; **admin undeletable 403**; weak reset 422; reset revokes sessions |
| 15 | Backups (FR-7) | config read; policy save; SQLite snapshot runs; JSON dump runs; **download = valid `SQLite format 3` file**; student cannot download |
| 16 | Destructive integrity (FR-4.1) | course delete = real server cascade; gone from catalog; 404 after; teacher deletable once courseless |

## 2 · Browser GUI Verification (Chromium, 1280×720)
| Flow | Result |
|------|--------|
| Gate — split screen, seal panel, role cards, live validation | ✓ |
| Admin overview (stat tiles), Accounts, Provision forms, Backup console | ✓ (fixed `pendingGrading` key) |
| Backup now → history row (168 KB snapshot) + download link | ✓ |
| Teacher: course list → Course Studio (chapters, materials, quiz, question rows) | ✓ |
| Student: catalog card with completion ring → course page | ✓ (fixed array→replaceChildren coercion bug) |
| Chapter done toggle → ring 0%→50% optimistic update | ✓ |
| **Video theater: streams via permission endpoint; `play()` advances currentTime; scrub to 4s lands instantly (206)** | ✓ |
| Quiz runner: 10-min countdown pill, navigator dots, autosave ticker, MC choices, DOC textarea + worksheet link + answer-file upload | ✓ |
| Submit → confirm dialog → redirected to results ("Pending review") | ✓ |
| Teacher submissions → "Awaiting grading (1 doc)" → review drawer (MC verdicts, typed answer, worksheet link) → score 5/6 → Save → **Release** | ✓ |
| Student breakdown: **9/10, 90% ring, per-question verdicts, your-answer vs correct-answer rows, teacher score chip** | ✓ |
| Reload with live session boots straight into the correct portal | ✓ (fixed router initial-dispatch race) |

## 3 · Defects Found & Fixed During Verification
| ID | Severity | Summary |
|----|----------|---------|
| D-1 | High | File-streaming responses were clobbered by the JSON fallback envelope → socket crash mid-stream. Fixed: dispatcher honors `headersSent`. |
| D-2 | High | Anonymous file request 500 (`user.role` on null) → fixed with optional chaining; now 404. |
| D-3 | High | Router initial dispatch fired before listeners registered → stuck splash on reload with hash. Fixed: deferred microtask dispatch + registration order. |
| D-4 | Medium | `replaceChildren` coerces array children to text (`[object HTMLDivElement]…`). Fixed in student course page + result breakdown via spread. |
| D-5 | Low | Admin overview read `pending_grading` instead of `pendingGrading` ("undefined" tile). Fixed. |

## 4 · Syntax Gates
`node --check` over all 28 server modules and all 8 frontend modules — **0 errors**.
