// ── Shire Jama LMS · end-to-end API smoke test ───────────────────────────
// Black-box suite against a running server (default http://localhost:3000).
// Covers: auth, provisioning, authoring, uploads (incl. fake-PDF rejection),
// quiz runtime, grading, release, results, backups, file permissions.
//
// Run: node scripts/smoke-test.js   (fresh data dir recommended)

const BASE = process.env.LMS_URL || 'http://localhost:3000';
let passed = 0, failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
};

const jars = {}; // role → cookie jar (simple map)
function cookieHeader(role) {
  return Object.entries(jars[role] || {}).map(([k, v]) => `${k}=${v}`).join('; ');
}
async function call(role, method, path, { body, rawBody, headers = {} } = {}) {
  const h = { 'X-Requested-With': 'fetch', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (role && jars[role]) h.Cookie = cookieHeader(role);
  const res = await fetch(BASE + path, {
    method, headers: h,
    body: rawBody !== undefined ? rawBody : (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const setCookie = res.headers.getSetCookie?.() || [];
  if (role) {
    jars[role] ??= {};
    for (const sc of setCookie) {
      const [pair] = sc.split(';');
      const i = pair.indexOf('=');
      if (pair.slice(0, i) === 'sid') jars[role].sid = pair.slice(i + 1);
    }
  }
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) { try { data = await res.json(); } catch {} }
  else if (method === 'GET' && (path.startsWith('/api/files') || path.startsWith('/api/admin/backups'))) {
    data = { bytes: Buffer.from(await res.arrayBuffer()) };
  }
  return { status: res.status, data, headers: res.headers };
}

const admin = (m, p, o) => call('admin', m, p, o);
const teacher = (m, p, o) => call('teacher', m, p, o);
const student = (m, p, o) => call('student', m, p, o);
const other = (m, p, o) => call('other', m, p, o);

/* fixtures */
const realPdf = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 99 99]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
const fakePdf = Buffer.from('This is a Word document renamed to .pdf — not a real PDF.');
const pngImg = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');

async function main() {
  console.log(`\nShire Jama LMS · smoke test → ${BASE}\n`);

  /* 1 · health + gate security */
  console.log('1 · Health & kernel');
  let r = await other('GET', '/api/health');
  ok('health endpoint responds', r.status === 200 && r.data.ok);
  // raw fetch WITHOUT the anti-CSRF header:
  const noHdr = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'admin', identifier: 'x', password: 'y' }),
  });
  ok('CSRF header is enforced', noHdr.status === 403);

  /* 2 · authentication */
  console.log('\n2 · Authentication (FR-1.x)');
  r = await other('POST', '/api/auth/login', { body: { role: 'admin', identifier: 'admin', password: 'WRONG' } });
  ok('wrong password rejected', r.status === 401);
  r = await call('admin', 'POST', '/api/auth/login', { body: { role: 'student', identifier: 'admin', password: process.env.ADMIN_PASSWORD || 'Admin@Shire2026' } });
  ok('role mismatch rejected', r.status === 401);
  r = await call('admin', 'POST', '/api/auth/login', { body: { role: 'admin', identifier: 'admin', password: process.env.ADMIN_PASSWORD || 'Admin@Shire2026' } });
  ok('admin login sets session', r.status === 200 && r.data.user?.role === 'admin' && jars.admin?.sid);
  r = await admin('GET', '/api/auth/me');
  ok('session resolves via /me', r.status === 200 && r.data.user?.username === 'admin');

  /* 3 · provisioning */
  console.log('\n3 · Provisioning (FR-3.1 / FR-3.2)');
  r = await admin('POST', '/api/admin/teachers', { body: { full_name: 'Test Teacher Two', email: `t2.${Date.now()}@shirejama.school`, password: 'weak' } });
  ok('weak password rejected with policy details', r.status === 422 && r.data.error?.code === 'weak_password');
  r = await admin('POST', '/api/admin/teachers', { body: { full_name: 'Test Teacher Two', email: `t2.${Date.now()}@shirejama.school`, password: 'Teacher@2026' } });
  ok('teacher provisioned, INST code auto-generated', r.status === 200 && /^INST-\d+$/.test(r.data.user?.instructor_code || ''));
  const teacherId = r.data.user.id;
  const teacherUsername = r.data.user.username;
  r = await admin('POST', '/api/admin/students', { body: { full_name: 'Test Student Two', email: `s2.${Date.now()}@shirejama.school`, academic_level: 'F2', password: 'Student@2026' } });
  ok('student registered, STD id auto-generated', r.status === 200 && /^STD-\d{4}-\d+$/.test(r.data.user?.student_id || ''));
  const studentId = r.data.user.id;
  const studentUsername = r.data.user.username;

  r = await call('teacher', 'POST', '/api/auth/login', { body: { role: 'teacher', identifier: teacherUsername, password: 'Teacher@2026' } });
  ok('new teacher can sign in immediately', r.status === 200);
  r = await call('student', 'POST', '/api/auth/login', { body: { role: 'student', identifier: studentUsername, password: 'Student@2026' } });
  ok('new student can sign in immediately', r.status === 200);

  r = await admin('GET', '/api/admin/users?role=teacher&q=Test Teacher Two');
  ok('accounts list is searchable', r.status === 200 && r.data.users.length >= 1);

  /* 4 · authorization boundaries */
  console.log('\n4 · Role boundaries');
  r = await teacher('GET', '/api/admin/stats');
  ok('teacher blocked from admin API', r.status === 401 || r.status === 403);
  r = await student('GET', '/api/teacher/courses');
  ok('student blocked from teacher API', r.status === 401 || r.status === 403);
  r = await other('GET', '/api/teacher/courses');
  ok('anonymous blocked', r.status === 401);

  /* 5 · course authoring */
  console.log('\n5 · Course authoring (FR-4.1 / FR-4.3)');
  r = await teacher('POST', '/api/teacher/courses', { body: { title: 'Smoke Test Course', description: 'e2e', levels: ['F2'] } });
  ok('course created', r.status === 200 && r.data.course?.id);
  const courseId = r.data.course.id;
  r = await teacher('POST', `/api/teacher/courses/${courseId}/chapters`, { body: { title: 'Chapter Alpha' } });
  ok('chapter added', r.status === 200);
  const chapterId = r.data.chapter.id;
  r = await teacher('PATCH', `/api/teacher/courses/${courseId}`, { body: { levels: ['F2', 'F3'] } });
  ok('course levels editable', r.status === 200 && r.data.course.levels.includes('F3'));

  /* 6 · material upload + magic-byte validation */
  console.log('\n6 · Materials & magic-byte validation (FR-4.4 / FR-4.5)');
  r = await teacher('PUT', `/api/teacher/chapters/${chapterId}/materials?title=Real%20PDF&kind=pdf&allow_download=1&name=t.pdf`,
    { rawBody: realPdf, headers: { 'Content-Type': 'application/pdf' } });
  ok('real PDF accepted', r.status === 200 && r.data.material?.id);
  const materialId = r.data.material?.id;
  r = await teacher('PUT', `/api/teacher/chapters/${chapterId}/materials?title=Fake&kind=pdf&name=fake.pdf`,
    { rawBody: fakePdf, headers: { 'Content-Type': 'application/pdf' } });
  ok('fake PDF (renamed Word doc) rejected', r.status === 415);
  r = await teacher('PUT', `/api/teacher/chapters/${chapterId}/materials?title=NotAVideo&kind=video&name=x.mp4`,
    { rawBody: fakePdf, headers: { 'Content-Type': 'video/mp4' } });
  ok('non-video container rejected', r.status === 415);

  /* 7 · quiz authoring */
  console.log('\n7 · Quiz authoring (FR-4.6 / FR-4.7)');
  r = await teacher('POST', `/api/teacher/chapters/${chapterId}/quizzes`, { body: {
    title: 'Smoke Quiz', instructions: 'Do your best.', time_limit_min: 10, max_attempts: 2, show_results: true } });
  ok('quiz created', r.status === 200);
  const quizId = r.data.quiz.id;

  // question image staging
  r = await teacher('PUT', '/api/teacher/files/question?kind=image&name=diagram.png',
    { rawBody: pngImg, headers: { 'Content-Type': 'image/png' } });
  ok('question image staged', r.status === 200 && r.data.token);
  const imgToken = r.data.token;

  r = await teacher('POST', `/api/teacher/quizzes/${quizId}/questions`, { body: {
    type: 'mc', prompt: 'Which is correct?', points: 2, image_token: imgToken,
    options: [{ label: 'a', is_correct: false }, { label: 'b', is_correct: true }, { label: 'c', is_correct: false }] } });
  ok('MC question with image added', r.status === 200 && r.data.question?.options?.length === 3);
  const mcQ = r.data.question.id;

  r = await teacher('PUT', '/api/teacher/files/question?kind=attachment&name=worksheet.pdf',
    { rawBody: realPdf, headers: { 'Content-Type': 'application/pdf' } });
  const attachToken = r.data.token;
  r = await teacher('POST', `/api/teacher/quizzes/${quizId}/questions`, { body: {
    type: 'doc', prompt: 'Read and respond.', points: 5, attachment_token: attachToken, attachment_name: 'worksheet.pdf' } });
  ok('DOC question with attachment added', r.status === 200 && r.data.question?.type === 'doc');
  const docQ = r.data.question.id;

  /* 8 · student visibility gate */
  console.log('\n8 · Student visibility (FR-2.3 / FR-5.1)');
  r = await student('GET', '/api/student/courses');
  const seen = r.data.courses.find((c) => c.id === courseId);
  ok('F2 student sees the F2-tagged course', !!seen);
  ok('catalog carries levels (dashboard render regression)',
    Array.isArray(seen?.levels) && seen.levels.includes('F2'));
  r = await call('seedstudent', 'POST', '/api/auth/login', { body: { role: 'student', identifier: 'amina.yusuf', password: 'Student@2026' } });
  const f1Sees = r.status === 200;
  if (f1Sees) {
    r = await call('seedstudent', 'GET', '/api/student/courses');
    ok('F1 student does NOT see the F2-only course', !r.data.courses.some((c) => c.id === courseId));
  }

  /* 9 · file access control */
  console.log('\n9 · File vault permissions (FR-6.x)');
  r = await call('seedstudent', 'GET', `/api/files/material/${materialId}`);
  ok('out-of-level student denied material', r.status === 404);
  r = await student('GET', `/api/files/material/${materialId}`);
  ok('in-level student streams material', r.status === 200);
  const anonRes = await fetch(`${BASE}/api/files/material/${materialId}`, { headers: { 'X-Requested-With': 'fetch' } });
  ok('anonymous denied material (401/404, never content)', [401, 403, 404].includes(anonRes.status));
  // range request
  const rangeRes = await fetch(`${BASE}/api/files/material/${materialId}`,
    { headers: { 'X-Requested-With': 'fetch', Cookie: cookieHeader('student'), Range: 'bytes=0-9' } });
  ok('range request → 206 partial content', rangeRes.status === 206
    && rangeRes.headers.get('content-range')?.startsWith('bytes 0-9/')
    && (await rangeRes.arrayBuffer()).byteLength === 10);

  /* 10 · quiz runtime */
  console.log('\n10 · Quiz runtime (FR-5.5 / FR-5.6)');
  r = await student('POST', `/api/student/quizzes/${quizId}/start`);
  ok('attempt started', r.status === 200 && r.data.attempt?.id);
  const attemptId = r.data.attempt.id;
  ok('deadline present for timed quiz', !!r.data.attempt.deadline_at);
  ok('running payload hides correct answers',
    !JSON.stringify(r.data.questions).includes('"is_correct"'));

  // autosave + answer file upload (doc)
  const correctOpt = r.data.questions.find((q) => q.id === mcQ).options[1].id;
  r = await student('PUT', `/api/student/attempts/${attemptId}/autosave`,
    { body: { answers: [{ question_id: mcQ, option_id: correctOpt }] } });
  ok('autosave accepted', r.status === 200);
  r = await student('PUT', `/api/student/attempts/${attemptId}/answer-file?question_id=${docQ}&name=my-essay.pdf`,
    { rawBody: realPdf, headers: { 'Content-Type': 'application/pdf' } });
  ok('answer file uploaded', r.status === 200);
  const answerFileOk = r.status === 200;

  r = await student('POST', `/api/student/attempts/${attemptId}/submit`,
    { body: { answers: [
      { question_id: mcQ, option_id: correctOpt },
      { question_id: docQ, text: 'Amina improved by studying one hour every morning before work.' }] } });
  ok('submit succeeds; DOC holds result (FR-4.8)', r.status === 200
    && r.data.status === 'submitted' && r.data.pending_manual_grading === true);
  const answerId = (await teacher('GET', `/api/teacher/attempts/${attemptId}`)).data.items
    .find((i) => i.question_id === docQ).answer_id;

  /* 11 · answer file privacy (FR-6.3) */
  if (answerFileOk) {
    r = await call('seedstudent', 'GET', `/api/files/answer/${answerId}`);
    ok('other student cannot read answer file', r.status === 404);
    r = await student('GET', `/api/files/answer/${answerId}`);
    ok('owner student reads own answer file', r.status === 200);
    r = await teacher('GET', `/api/files/answer/${answerId}`);
    ok('owning teacher reads answer file', r.status === 200);
  }

  /* 12 · grading & release */
  console.log('\n12 · Grading & release (FR-4.9 / FR-4.10)');
  r = await teacher('GET', '/api/teacher/submissions?status=submitted');
  ok('submission appears in overview', r.data.submissions.some((s) => s.id === attemptId));
  r = await teacher('POST', `/api/teacher/attempts/${attemptId}/release`, { body: {} });
  ok('release blocked until doc answers scored', r.status === 409);
  r = await teacher('POST', `/api/teacher/attempts/${attemptId}/score`,
    { body: { scores: [{ answer_id: answerId, score: 99 }] } });
  ok('out-of-range score rejected', r.status === 400);
  r = await teacher('POST', `/api/teacher/attempts/${attemptId}/score`,
    { body: { scores: [{ answer_id: answerId, score: 4 }] } });
  ok('manual score saved; attempt graded', r.status === 200 && r.data.status === 'graded');
  r = await student('GET', `/api/student/results/${attemptId}`);
  ok('student still blocked before release', r.status === 403);
  r = await teacher('POST', `/api/teacher/attempts/${attemptId}/release`, { body: {} });
  ok('release succeeds after grading', r.status === 200);
  r = await student('GET', `/api/student/results/${attemptId}`);
  ok('released breakdown shows score + correct answers',
    r.status === 200 && r.data.attempt.score === 6 && r.data.attempt.max_score === 7
    && r.data.items.find((i) => i.question_id === mcQ)?.correct_option?.id === correctOpt);
  r = await student('GET', '/api/student/results');
  ok('history lists released attempt with score', r.data.attempts.some((a) => a.id === attemptId && a.score === 6));

  /* 13 · attempt limits */
  console.log('\n13 · Attempt windows & limits');
  r = await student('POST', `/api/student/quizzes/${quizId}/start`);
  ok('second attempt allowed (max 2)', r.status === 200);
  await student('POST', `/api/student/attempts/${r.data.attempt.id}/submit`, { body: { answers: [{ question_id: mcQ, option_id: correctOpt }] } });
  r = await student('POST', `/api/student/quizzes/${quizId}/start`);
  ok('third attempt blocked by max_attempts', r.status === 409);

  /* 13b · analytics (admin rollup + teacher cohort) */
  console.log('\n13b · Analytics');
  r = await teacher('GET', `/api/teacher/courses/${courseId}/analytics`);
  const an = r.data;
  ok('teacher course analytics returns cohort + summary',
    r.status === 200 && an.summary && Array.isArray(an.students) && an.course.levels.includes('F2'));
  ok('cohort includes the F2 student with attempt data',
    an.students.some((s) => s.id === studentId && s.attempts >= 1));
  ok('quiz outcome rows present', an.quizzes.length === 1 && an.quizzes[0].attempts >= 1);
  r = await student('GET', `/api/teacher/courses/${courseId}/analytics`);
  ok('students cannot call teacher analytics', r.status === 401 || r.status === 403);
  r = await admin('GET', '/api/admin/analytics/teachers');
  const trow = r.data.teachers?.find((t) => t.id === teacherId);
  ok('admin teacher rollup includes this teacher',
    r.status === 200 && trow && trow.course_count >= 1 && trow.attempt_count >= 1);
  ok('institution summary present', r.data.summary && r.data.summary.courses >= 1);
  r = await admin('GET', '/api/admin/activity');
  ok('recent sign-ins feed present',
    r.status === 200 && Array.isArray(r.data.signins) && r.data.signins.length >= 1);
  r = await student('GET', '/api/admin/activity');
  ok('students blocked from activity feed', r.status === 401 || r.status === 403);

  /* 13c · pure-MC quiz with instant results (auto-award path) */
  console.log('\n13c · Instant auto-award (pure MC + show_results)');
  r = await teacher('POST', `/api/teacher/courses/${courseId}/chapters`, { body: { title: 'Instant chapter' } });
  const ch2Id = r.data.chapter.id;
  r = await teacher('POST', `/api/teacher/chapters/${ch2Id}/quizzes`,
    { body: { title: 'Instant MC Quiz', show_results: true } });
  const quiz2 = r.data.quiz.id;
  await teacher('POST', `/api/teacher/quizzes/${quiz2}/questions`, { body: {
    type: 'mc', prompt: 'Instant q?', points: 4,
    options: [{ label: 'no', is_correct: false }, { label: 'yes', is_correct: true }] } });
  r = await student('POST', `/api/student/quizzes/${quiz2}/start`);
  const instAttempt = r.data.attempt.id;
  const instQ = r.data.questions[0];
  // choose the option the teacher marked correct — read it from the authoring tree
  const authored = await teacher('GET', `/api/teacher/courses/${courseId}`);
  const authoredQ = authored.data.course.chapters.flatMap((h) => h.quizzes)
    .find((z) => z.id === quiz2).questions[0];
  const correctOptId = authoredQ.options.find((o) => o.is_correct).id;
  r = await student('POST', `/api/student/attempts/${instAttempt}/submit`,
    { body: { answers: [{ question_id: instQ.id, option_id: correctOptId }] } });
  ok('pure-MC submit auto-releases instantly',
    r.status === 200 && r.data.status === 'released' && r.data.score === 4 && r.data.max_score === 4);
  r = await student('GET', `/api/student/results/${instAttempt}`);
  ok('student sees auto-awarded breakdown immediately',
    r.status === 200 && r.data.attempt.score === 4 && r.data.items[0].is_correct === true);

  /* 14 · account management guards */
  console.log('\n14 · Account management guards (FR-3.4–3.7)');
  r = await admin('PATCH', `/api/admin/users/${studentId}`, { body: { is_active: false } });
  ok('account deactivated', r.status === 200 && r.data.user.is_active === false);
  r = await call('student', 'GET', '/api/auth/me');
  ok('deactivated session killed or blocked', r.status === 401 || r.status === 403);
  r = await admin('PATCH', `/api/admin/users/${studentId}`, { body: { is_active: true } });
  ok('account re-activated', r.status === 200 && r.data.user.is_active === true);
  r = await admin('DELETE', `/api/admin/users/${teacherId}`);
  ok('teacher with courses cannot be deleted', r.status === 409);
  r = await admin('DELETE', '/api/admin/users/1');
  ok('administrator undeletable', r.status === 403);
  r = await admin('POST', `/api/admin/users/${studentId}/reset-password`, { body: { password: 'weak' } });
  ok('weak reset rejected', r.status === 422);
  r = await admin('POST', `/api/admin/users/${studentId}/reset-password`, { body: { password: 'NewPass@2026' } });
  ok('password reset revokes sessions', r.status === 200 && (await student('GET', '/api/auth/me')).status === 401);

  /* 15 · backups (FR-7) */
  console.log('\n15 · Backup console (FR-7)');
  const CF = process.env.CF === '1'; // Workers build: JSON dumps (no VACUUM INTO)
  r = await admin('GET', '/api/admin/backups');
  ok('backup config + history readable', r.status === 200 && r.data.config);
  r = await admin('PUT', '/api/admin/backups/config', { body: { enabled: true, frequency: 'daily', scope: 'accounts', format: CF ? 'json' : 'sqlite', retention: 5 } });
  ok('policy saved', r.status === 200 && r.data.config.scope === 'accounts');
  r = await admin('POST', '/api/admin/backups/run', { body: { scope: 'full', format: CF ? 'json' : 'sqlite' } });
  ok(`${CF ? 'json dump' : 'sqlite snapshot'} runs`, r.status === 200 && r.data.backup?.size_bytes > 0);
  const backupId = r.data.backup.id;
  r = await admin('POST', '/api/admin/backups/run', { body: { scope: 'results', format: 'json' } });
  ok('scoped json dump runs', r.status === 200);
  const dl = await fetch(`${BASE}/api/admin/backups/${backupId}/download`, { headers: { 'X-Requested-With': 'fetch', Cookie: cookieHeader('admin') } });
  const dlBytes = Buffer.from(await dl.arrayBuffer());
  ok('backup downloads (' + (CF ? 'valid JSON' : 'valid sqlite header') + ')', dl.status === 200
    && (CF ? JSON.parse(dlBytes.toString('utf8')).meta?.product === 'Shire Jama LMS'
           : dlBytes.subarray(0, 15).toString().startsWith('SQLite format 3')));
  r = await student('GET', `/api/admin/backups/${backupId}/download`);
  ok('students cannot download backups', r.status === 401 || r.status === 403);

  /* 16 · course deletion cascades for real */
  console.log('\n16 · Destructive integrity (FR-4.1)');
  // student session was revoked by the password reset above — sign in again
  await call('student', 'POST', '/api/auth/login', { body: { role: 'student', identifier: studentUsername, password: 'NewPass@2026' } });
  r = await teacher('DELETE', `/api/teacher/courses/${courseId}`);
  ok('course deleted via real server request', r.status === 200);
  r = await student('GET', '/api/student/courses');
  ok('course gone from student catalog', !r.data.courses.some((c) => c.id === courseId));
  r = await teacher('GET', `/api/teacher/courses/${courseId}`);
  ok('course 404s after deletion', r.status === 404);
  r = await admin('DELETE', `/api/admin/users/${teacherId}`);
  ok('teacher now deletable (no courses)', r.status === 200);

  console.log(`\n──────────────────────────────\n  ${passed} passed · ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('SUITE CRASHED:', e); process.exit(2); });
