-- Shire Jama LMS · schema (idempotent; see docs/03_DATA_MODEL.md)
-- NOTE: users.email is NULLABLE — students have NO email (they sign in with
-- their Student ID); teachers/admins still require one.
-- materials supports kind='link' with link_url (external learning resources).
-- courses.resource_url is an optional course-level external material link.
-- Existing databases are upgraded by server/core/migrate.js — this file is
-- the fresh-install shape.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  role           TEXT NOT NULL CHECK (role IN ('admin','teacher','student')),
  full_name      TEXT NOT NULL,
  username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email          TEXT UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 1,
  instructor_code TEXT UNIQUE,
  student_id     TEXT UNIQUE,
  academic_level TEXT CHECK (academic_level IS NULL OR academic_level IN
    ('C1','C2','C3','C4','C5','C6','C7','C8','F1','F2','F3','F4')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_role      ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_active    ON users(is_active);

CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS courses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  teacher_id   INTEGER NOT NULL REFERENCES users(id),
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  resource_url TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_courses_teacher ON courses(teacher_id);

CREATE TABLE IF NOT EXISTS course_levels (
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  level     TEXT NOT NULL,
  PRIMARY KEY (course_id, level)
);

CREATE TABLE IF NOT EXISTS chapters (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id  INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chapters_course ON chapters(course_id, position);

CREATE TABLE IF NOT EXISTS materials (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id     INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('pdf','video','link')),
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  file_name      TEXT NOT NULL DEFAULT '',
  stored_path    TEXT,
  mime           TEXT NOT NULL DEFAULT '',
  size_bytes     INTEGER NOT NULL DEFAULT 0,
  allow_download INTEGER NOT NULL DEFAULT 0,
  link_url       TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_materials_chapter ON materials(chapter_id);

CREATE TABLE IF NOT EXISTS quizzes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter_id      INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  instructions    TEXT NOT NULL DEFAULT '',
  time_limit_min  INTEGER,
  opens_at        TEXT,
  closes_at       TEXT,
  max_attempts    INTEGER,
  show_results    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quizzes_chapter ON quizzes(chapter_id);

CREATE TABLE IF NOT EXISTS questions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id          INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  type             TEXT NOT NULL CHECK (type IN ('mc','doc')),
  prompt           TEXT NOT NULL,
  points           INTEGER NOT NULL DEFAULT 1,
  image_path       TEXT,
  attachment_path  TEXT,
  attachment_name  TEXT,
  position         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id, position);

CREATE TABLE IF NOT EXISTS options (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  is_correct  INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_options_question ON options(question_id);

CREATE TABLE IF NOT EXISTS attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id      INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  student_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempt_no   INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN
    ('in_progress','submitted','graded','released')),
  started_at   TEXT NOT NULL,
  submitted_at TEXT,
  auto_score   REAL,
  manual_total REAL,
  graded_at    TEXT,
  released_at  TEXT,
  UNIQUE (quiz_id, student_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_attempts_quiz    ON attempts(quiz_id, student_id);
CREATE INDEX IF NOT EXISTS idx_attempts_status  ON attempts(status);

CREATE TABLE IF NOT EXISTS answers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id   INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id  INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  option_id    INTEGER,
  text_answer  TEXT,
  file_path    TEXT,
  file_name    TEXT,
  is_correct   INTEGER,
  score        REAL,
  UNIQUE (attempt_id, question_id)
);
CREATE INDEX IF NOT EXISTS idx_answers_attempt ON answers(attempt_id);

CREATE TABLE IF NOT EXISTS progress (
  student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  done_at    TEXT NOT NULL,
  PRIMARY KEY (student_id, chapter_id)
);
CREATE INDEX IF NOT EXISTS idx_progress_student ON progress(student_id);

CREATE TABLE IF NOT EXISTS backup_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name  TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  scope      TEXT NOT NULL,
  format     TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'ok',
  created_at TEXT NOT NULL
);
