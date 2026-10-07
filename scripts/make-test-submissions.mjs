// Test fixture: second course for hodan + amina submits quizzes in both
// courses, so the per-student/per-course grouping is visible in the UI.
const BASE = process.env.LMS_URL || 'http://localhost:3000';
const jars = {};
const cookie = (j) => Object.entries(jars[j] || {}).map(([k, v]) => `${k}=${v}`).join('; ');
async function call(j, method, path, { body } = {}) {
  const h = { 'X-Requested-With': 'fetch' };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (j && jars[j]) h.Cookie = cookie(j);
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const [p] = sc.split(';'); const i = p.indexOf('=');
    if (p.slice(0, i) === 'sid') (jars[j] ??= {}).sid = p.slice(i + 1);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data).slice(0, 120)}`);
  return data;
}
const login = (j, role, id, pw) => call(j, 'POST', '/api/auth/login', { body: { role, identifier: id, password: pw } });

await login('t', 'teacher', 'hodan.abdi', 'Teacher@2026');
await login('s', 'student', 'amina.yusuf', 'Student@2026');

const mine = await call('t', 'GET', '/api/teacher/courses');
const demo = mine.courses.find((c) => c.title.includes('English Foundations'));
let second = mine.courses.find((c) => c.title.includes('Kiswahili'));
if (!second) {
  second = (await call('t', 'POST', '/api/teacher/courses', { body: {
    title: 'Kiswahili Mufti: Reading & Grammar', description: 'Kiswahili basics for adult learners.', levels: ['F1'] } })).course;
  const ch = (await call('t', 'POST', `/api/teacher/courses/${second.id}/chapters`, { body: { title: 'Sura ya 1 · Msingi' } })).chapter;
  const q2 = (await call('t', 'POST', `/api/teacher/chapters/${ch.id}/quizzes`, { body: {
    title: 'Kiswahili Check: Msingi', instructions: 'Jibu maswali yote.', show_results: true } })).quiz;
  await call('t', 'POST', `/api/teacher/quizzes/${q2.id}/questions`, { body: {
    type: 'mc', prompt: 'Neno "kitabu" maana yake ni?', points: 3,
    options: [{ label: 'book', is_correct: true }, { label: 'pen', is_correct: false }, { label: 'table', is_correct: false }] } });
  await call('t', 'POST', `/api/teacher/quizzes/${q2.id}/questions`, { body: {
    type: 'doc', prompt: 'Andika aya fupi kuhusu siku yako (3-5 sentensi).', points: 5 } });
}

// amina attempts every quiz in both courses
for (const course of [demo, second].filter(Boolean)) {
  const tree = await call('s', 'GET', `/api/student/courses/${course.id}`);
  for (const ch of tree.chapters) {
    for (const z of ch.quizzes) {
      if (z.state !== 'available' || z.running_attempt_id) continue;
      const run = await call('s', 'POST', `/api/student/quizzes/${z.id}/start`);
      const answers = run.questions.map((q) => q.type === 'mc'
        ? { question_id: q.id, option_id: q.options[0]?.id ?? null }
        : { question_id: q.id, text: 'Mazoezi ya kila siku hutengeneza uelewaji.' });
      await call('s', 'POST', `/api/student/attempts/${run.attempt.id}/submit`, { body: { answers } });
      console.log(`submitted: ${z.title} (${course.title})`);
    }
  }
}
console.log('fixture done');
