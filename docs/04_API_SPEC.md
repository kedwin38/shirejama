# Shire Jama LMS — HTTP API Contract
All JSON unless noted. Auth = `sid` HttpOnly cookie. Errors:
`{ "error": { "code": "…", "message": "…" } }` with proper HTTP status.
File uploads are **raw bodies** (`PUT`) with metadata in the query string —
no multipart anywhere.

## Envelope codes
`400 bad_request · 401 unauthorized · 403 forbidden · 404 not_found ·
409 conflict · 413 payload_too_large · 415 unsupported_media ·
422 weak_password / policy_violation · 429 rate_limited`

## Auth `/api/auth`
| Method | Path | Body / Notes |
|---|---|---|
| POST | `/login` | `{role, identifier, password}` → sets cookie; returns profile |
| POST | `/logout` | destroys session |
| GET  | `/me` | current profile |
| POST | `/change-password` | `{current, next}` (policy enforced) |

## Admin `/api/admin` (role: admin)
| Method | Path | Notes |
|---|---|---|
| GET | `/stats` | teachers, students, courses, active counts, backups |
| GET | `/users?role=&q=&status=` | list w/ course counts |
| POST | `/teachers` | `{full_name, email, instructor_code?, password}` |
| POST | `/students` | `{full_name, email, academic_level, password}` |
| PATCH | `/users/:id` | edit identity/role fields/`is_active` |
| POST | `/users/:id/reset-password` | `{password}` |
| DELETE | `/users/:id` | guarded (admins undeletable; teachers w/ courses blocked) |
| GET | `/analytics/teachers` | institution summary + per-teacher rollup: courses, chapters, materials, quizzes, students reached, attempts, avg released score %, pending grading, last activity |

## Admin — Backups `/api/admin/backups`
| Method | Path | Notes |
|---|---|---|
| GET | `/` | `{config, history}` |
| PUT | `/config` | `{enabled, frequency, retention, format, scope}` |
| POST | `/run` | `{scope?, format?}` → runs synchronously, returns record |
| GET | `/:id/download` | streams backup file (admin only) |
| DELETE | `/:id` | removes record + file |

## Teacher `/api/teacher` (role: teacher; ownership enforced)
| Method | Path | Notes |
|---|---|---|
| GET | `/courses` | own courses + chapter/quiz/material counts |
| POST | `/courses` | `{title, description, levels[]}` |
| PATCH | `/courses/:id` · DELETE `/courses/:id` | |
| GET | `/courses/:id` | full authoring tree (chapters, materials, quizzes, questions+options) |
| GET | `/courses/:id/analytics` | cohort analytics: cohort size, avg completion, per-chapter completion, per-quiz outcomes (attempts/students/avg %/pending), per-student rows |
| POST | `/courses/:id/chapters` | `{title}` |
| PATCH | `/chapters/:id` · DELETE `/chapters/:id` · POST `/chapters/:id/move` `{dir}` | |
| PUT | `/chapters/:id/materials?title=&description=&kind=&allow_download=` | raw body = file bytes; magic-byte validated |
| DELETE | `/materials/:id` | DB row + stored file |
| POST | `/chapters/:id/quizzes` | quiz fields |
| PATCH | `/quizzes/:id` · DELETE `/quizzes/:id` | |
| PUT | `/files/question?kind=image|attachment&name=` | step 1 of question authoring; returns `{token}` |
| POST | `/quizzes/:id/questions` | `{type,prompt,points,image_token?,attachment_token?,attachment_name?,options?[]}` |
| DELETE | `/questions/:id` | |
| GET | `/submissions?quiz_id=&status=` | attempts across own courses |
| GET | `/attempts/:id` | full review payload (answers, correctness, files) |
| POST | `/attempts/:id/score` | `{scores:[{answer_id,score}]}` → status `graded` when complete |
| POST | `/attempts/:id/release` | `submitted|graded → released` |

## Student `/api/student` (role: student)
| Method | Path | Notes |
|---|---|---|
| GET | `/courses` | level-matched catalog + progress % + quiz availability |
| GET | `/courses/:id` | full learning tree |
| PUT | `/progress/:chapterId` | `{done:boolean}` toggle |
| POST | `/quizzes/:id/start` | window + attempts enforced; resume `in_progress` |
| GET | `/attempts/:id` | running payload (never leaks correct answers) |
| PUT | `/attempts/:id/answer-file?question_id=` | raw body = answer file (pdf/doc/docx/img) |
| POST | `/attempts/:id/submit` | `{answers:[{question_id, option_id?, text?}]}` |
| GET | `/results` | attempt history (score only if released) |
| GET | `/results/:attemptId` | released breakdown incl. correct answers |

## File vault `/api/files` (all permission-checked; Range honored)
| Path | Who may read |
|---|---|
| `/material/:id[?download=1]` | students of matching level; owning teacher; admin. `download=1` requires `allow_download` |
| `/question/:id?kind=image\|attachment` | level-matched students; owning teacher; admin |
| `/answer/:id` | the student owner; owning teacher; admin |
Responses: `Content-Disposition: inline` (attachment when allowed download),
`Accept-Ranges: bytes`, `206` on Range, security headers on every file response.
