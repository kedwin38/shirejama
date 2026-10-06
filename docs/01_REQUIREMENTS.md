# Shire Jama LMS — Software Requirements Specification (SRS)
Version 1.0 · 2026-10-06 · Source: institutional brief + engineering analysis

## 1. Product Identity
- **Product:** Shire Jama LMS ("the Platform")
- **Client:** Shire Jama'a Ahmed Adult School — an adult learning institution
- **Motto (from institutional seal):** *"Education Without Limits"*
- **Users:** Administrators, Teachers (Instructors), Students — all adult learners; worldwide access across time zones and low-bandwidth regions.

## 2. Functional Requirements

### FR-1 Access & Identity
| ID | Requirement |
|----|-------------|
| FR-1.1 | Single "Sign In / Portal Access" entry point; user selects role (Student / Teacher / Administrator) before authenticating. |
| FR-1.2 | Sign-in with username **or** email + password. Selected role must match the account's role. |
| FR-1.3 | No student/teacher self-registration. All accounts are provisioned by an Administrator. |
| FR-1.4 | Sessions are server-side, expire after inactivity, and survive server restarts. |
| FR-1.5 | Passwords hashed with scrypt + per-user salt; timing-safe comparison; login rate-limited. |
| FR-1.6 | Password policy (enforced server-side, mirrored client-side): min 8 chars, ≥1 uppercase, ≥1 lowercase, ≥1 digit. Weak passwords rejected with a clear error. |
| FR-1.7 | Deactivated accounts cannot sign in (explicit "account deactivated" feedback). |

### FR-2 Academic Structure
| ID | Requirement |
|----|-------------|
| FR-2.1 | Content hierarchy: **Course → Chapters → (Materials and/or Quizzes)**. |
| FR-2.2 | Academic levels: Class 1–8 (`C1..C8`) and Form 1–4 (`F1..F4`). A course is tagged ≥1 level. |
| FR-2.3 | Students are assigned exactly one level; they see **only** courses tagged with their level. No self-enrollment. |

### FR-3 Administrator
| ID | Requirement |
|----|-------------|
| FR-3.1 | Provision teacher accounts: full name, email, optional instructor code; code auto-generates as `INST-101, INST-102, …` when omitted. Admin sets a temporary password (policy-enforced). New teacher can sign in immediately. |
| FR-3.2 | Register student accounts: full name, email, academic level; student ID auto-generates as `STD-<year>-1001, 1002, …`; admin sets a temporary password (policy-enforced). |
| FR-3.3 | List all teachers and students with active/inactive status and course-ownership counts; searchable/filterable. |
| FR-3.4 | Edit accounts: full name, username, email, and role-specific fields (student ID + level; instructor code). |
| FR-3.5 | Activate/deactivate accounts (soft toggle, never destructive). |
| FR-3.6 | Reset any user's password (policy enforced; weak → on-screen error). |
| FR-3.7 | Permanently delete teacher/student accounts — with guards: (a) an administrator account can never be deleted here; (b) a teacher owning ≥1 course cannot be deleted (admin must first delete/reassign courses or deactivate the account) — no silent destruction of course content. |
| FR-3.8 | Institutional dashboard: counts of teachers, students, courses, active accounts. |
| FR-3.9 | **Backup Console** (see FR-7). |

### FR-4 Teacher
| ID | Requirement |
|----|-------------|
| FR-4.1 | Create/edit/delete courses (title, description, ≥1 level). Deletion is a confirmed server operation cascading chapters, materials, quizzes, grades, and stored files. |
| FR-4.2 | Teachers see and manage **only their own** courses. |
| FR-4.3 | Add/edit/delete/reorder chapters within a course. |
| FR-4.4 | Upload PDF / video materials to a chapter: title, optional description, downloadable toggle. PDFs validated server-side by magic bytes (`%PDF-`); videos validated by container signature (MP4/MOV `ftyp` brand / WebM `EBML`). |
| FR-4.5 | Delete a material — removes DB record **and** stored file. |
| FR-4.6 | Author quizzes per chapter: title, instructions, optional timer (minutes), optional open/close window, optional max attempts, "show results immediately" toggle. |
| FR-4.7 | Question types: **MULTIPLE_CHOICE** (options, one correct, optional attached image; auto-graded) and **DOCUMENT** (prompt + attached file for the student to read; answered by typed text and/or uploaded PDF/Word/image; always manually graded). |
| FR-4.8 | A quiz containing ≥1 DOCUMENT question is held for manual grading even when "show results immediately" is on. |
| FR-4.9 | Submissions overview: every attempt, filterable by status; "Review answers" per attempt showing prompt, attachments, student answer (text and/or file), MC correctness; open any file in a new tab. |
| FR-4.10 | Enter manual scores per question; "Release result" publishes a held-back score to the student. |

### FR-5 Student
| ID | Requirement |
|----|-------------|
| FR-5.1 | Dashboard lists all courses matching the student's level, with per-course completion % (chapters marked done). |
| FR-5.2 | PDF materials open in an in-browser viewer (streaming; download button only if the teacher allowed it). |
| FR-5.3 | Video lectures stream with full seek/scrub (HTTP 206 range serving). |
| FR-5.4 | Mark chapters "Done"; visible completion state; feeds completion %. |
| FR-5.5 | Start quizzes respecting open/close window and max attempts. Timed quizzes show a live countdown; answers autosave locally (crash/reload safe); auto-submit at zero. |
| FR-5.6 | MC questions: select an option; view attached question images. DOCUMENT questions: type an answer, upload a file (PDF/Word/image), or both; open the teacher's attached file. |
| FR-5.7 | Fully-auto-graded quiz + "show immediately" → instant score. Otherwise "Pending review" until teacher releases. |
| FR-5.8 | Released results show full per-question breakdown (own answer, correctness, correct answer). Running history of all attempts + scores. |

### FR-6 File Security
| ID | Requirement |
|----|-------------|
| FR-6.1 | No raw public file URLs. Every file is served by a permission-checked endpoint. |
| FR-6.2 | Students access only material/quizzes of courses matching their level. |
| FR-6.3 | A student's answer file is visible only to that student, the owning teacher, and administrators. |
| FR-6.4 | Stored filenames are server-generated (UUID); original names kept as metadata. Path traversal impossible by construction. |

### FR-7 Backup Console (Administrator)
| ID | Requirement |
|----|-------------|
| FR-7.1 | Admin tab to configure automated database backups through an **abstraction layer** (pluggable format writers + pluggable storage targets). |
| FR-7.2 | Selectable scope: **Accounts** (all logins & profile data), **Results** (attempts, answers, progress), or **Full** (everything). |
| FR-7.3 | Formats: SQLite consistent snapshot (`VACUUM INTO`) and human-readable JSON dump. |
| FR-7.4 | Schedule: off / every 6h / daily / weekly; retention count (auto-prune oldest). |
| FR-7.5 | "Backup now", download, delete; history table (scope, format, size, timestamp, status). |

## 3. Non-Functional Requirements
| ID | Category | Requirement |
|----|----------|-------------|
| NFR-1 | Scalability | All file I/O is streamed (never buffered in RAM); uploads stream to disk with size caps; DB indexed for hot paths; WAL mode for concurrent readers + writer. State is externalized (sessions/files/DB) so multiple app instances can run behind a load balancer against shared storage. |
| NFR-2 | Concurrency | Atomic attempt claiming (single in-progress attempt per student/quiz), transactions for cascading mutations, DB-side uniqueness guards. |
| NFR-3 | Global access | UTC storage + local-time rendering (Intl), UTF-8 everywhere, low-bandwidth friendly (no framework payload, streaming media, cacheable static assets with immutable hashing). |
| NFR-4 | Security | scrypt password hashing, HttpOnly+SameSite cookies, CSRF-hardened (custom header + SameSite), role middleware, object-level authorization on every route, magic-byte validation, rate-limited auth, no path traversal, CSP headers on file responses. |
| NFR-5 | Reliability | Server-restart-safe sessions; idempotent seed; graceful error envelopes; online consistent backups. |
| NFR-6 | Maintainability | Layered architecture (kernel → services → routes), zero runtime npm dependencies (no supply-chain surface), full SDLC documentation. |
| NFR-7 | Accessibility | WCAG 2.1 AA contrast, keyboard-complete flows, visible focus, ARIA on interactive widgets, `prefers-reduced-motion` honored. |
| NFR-8 | UX | Distinctive institutional design language (seal-derived); skeleton loaders; optimistic UI; command palette; autosave; toast feedback; light/dusk themes. |
