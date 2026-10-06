# Shire Jama LMS — Data Model (ERD & Schema)
SQLite · WAL · foreign_keys ON · all timestamps ISO-8601 UTC text.

## ERD
```
users 1──* courses 1──* chapters 1──* materials
  │1                     │1
  │                      └──* quizzes 1──* questions 1──* options
  │*                                        │1                │
  └──* attempts *──1 quizzes ───────────────┘                 │
        │1                                                    │
        └──* answers *──1 questions  (answers.option_id ──────┘)
users 1──* progress *──1 chapters
users 1──* sessions (cascade)
backup_config (k/v) ; backups (history)
```

## Tables

```sql
users(
  id INTEGER PK AUTOINCREMENT,
  role TEXT CHECK(role IN ('admin','teacher','student')),
  full_name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email    TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,             -- scrypt: salt$N$r$p$key (hex)
  is_active INTEGER NOT NULL DEFAULT 1,
  instructor_code TEXT UNIQUE,             -- teachers: INST-101…
  student_id TEXT UNIQUE,                  -- students: STD-YYYY-1001…
  academic_level TEXT CHECK(academic_level IN
      ('C1'..'C8','F1'..'F4') OR NULL),    -- students only
  created_at TEXT, updated_at TEXT
)

sessions(token TEXT PK, user_id→users CASCADE, created_at,
         expires_at, last_seen_at, ip, user_agent)

courses(id PK, teacher_id→users, title, description,
        created_at, updated_at)
course_levels(course_id→courses CASCADE, level, PK(course_id,level))

chapters(id PK, course_id→courses CASCADE, title, position,
         created_at)                       -- position: 1..n per course

materials(id PK, chapter_id→chapters CASCADE,
          kind CHECK(kind IN ('pdf','video')),
          title, description, file_name, stored_path, mime,
          size_bytes, allow_download INT DEFAULT 0, created_at)

quizzes(id PK, chapter_id→chapters CASCADE, title, instructions,
        time_limit_min INT NULL, opens_at TEXT NULL, closes_at TEXT NULL,
        max_attempts INT NULL, show_results INT DEFAULT 0,
        created_at, updated_at)

questions(id PK, quiz_id→quizzes CASCADE,
          type CHECK(type IN ('mc','doc')),
          prompt TEXT NOT NULL, points INT NOT NULL DEFAULT 1,
          image_path TEXT NULL,             -- mc: attached image
          attachment_path TEXT NULL,        -- doc: attached file
          attachment_name TEXT NULL,
          position INT)

options(id PK, question_id→questions CASCADE, label TEXT,
        is_correct INT DEFAULT 0, position INT)

attempts(id PK, quiz_id→quizzes CASCADE, student_id→users CASCADE,
         attempt_no INT, status CHECK(status IN
            ('in_progress','submitted','graded','released')),
         started_at, submitted_at NULL, auto_score REAL NULL,
         manual_total REAL NULL, graded_at NULL, released_at NULL,
         UNIQUE(quiz_id, student_id, attempt_no))

answers(id PK, attempt_id→attempts CASCADE, question_id→questions CASCADE,
        option_id INT NULL, text_answer TEXT NULL,
        file_path TEXT NULL, file_name TEXT NULL,       -- doc uploads
        is_correct INT NULL, score REAL NULL,
        UNIQUE(attempt_id, question_id))

progress(student_id, chapter_id→chapters CASCADE, done_at,
         PK(student_id, chapter_id))

backup_config(key TEXT PK, value TEXT)
backups(id PK, file_name, stored_path, scope, format,
        size_bytes, status, created_at)
```

## Indexes (hot paths)
- `users(role)`, `users(is_active)` — account lists
- `courses(teacher_id)` — teacher ownership checks
- `chapters(course_id, position)` — content tree assembly
- `attempts(quiz_id, student_id)` — availability & resume
- `attempts(status)` — submissions overview filters
- `answers(attempt_id)` — grading screens
- `progress(student_id)` — completion percentage

## Integrity Rules Enforced in Services
- Teacher deletion blocked while `courses(teacher_id) COUNT > 0` (FR-3.7).
- Admin role rows never deletable via admin API (FR-3.7a).
- Course deletion = transaction (delete rows) + post-commit best-effort file purge.
- `attempt_no` uniqueness prevents double-start races (NFR-2).
- Student visibility join: `course_levels ∋ student.academic_level`.
