// Seeds the demo dataset on a DEPLOYED instance through its own live API —
// the same flow a real admin/teacher would use (also validates the pipeline).
const BASE = process.env.LMS_URL || 'https://shirejama.7956kariukiedwin.workers.dev';
const ADMIN_PW = process.env.ADMIN_PASSWORD;

const jars = {};
const cookie = (r) => Object.entries(jars[r] || {}).map(([k, v]) => `${k}=${v}`).join('; ');
async function call(role, method, path, { body, rawBody, headers = {} } = {}) {
  const h = { 'X-Requested-With': 'fetch', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (role && jars[role]) h.Cookie = cookie(role);
  const res = await fetch(BASE + path, { method, headers: h, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const [pair] = sc.split(';'); const i = pair.indexOf('=');
    if (pair.slice(0, i) === 'sid') (jars[role] ??= {}).sid = pair.slice(i + 1);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(data).slice(0, 160)}`);
  return data;
}
const login = (jar, role, id, pw) => call(jar, 'POST', '/api/auth/login', { body: { role, identifier: id, password: pw } });

await login('admin', 'admin', 'admin', ADMIN_PW);
const stats = await call('admin', 'GET', '/api/admin/stats');
if (stats.courses > 0) { console.log('demo already seeded'); process.exit(0); }

await call('admin', 'POST', '/api/admin/teachers', { body: { full_name: 'Hodan Abdi', email: 'hodan.abdi@shirejama.school', password: 'Teacher@2026' } }).catch(() => {});
await call('admin', 'POST', '/api/admin/students', { body: { full_name: 'Amina Yusuf', email: 'amina.yusuf@shirejama.school', academic_level: 'F1', password: 'Student@2026' } }).catch(() => {});

await login('t', 'teacher', 'hodan.abdi', 'Teacher@2026');
const { course } = await call('t', 'POST', '/api/teacher/courses', { body: {
  title: 'English Foundations: Reading & Writing',
  description: 'A grounding in practical English for adult learners — grammar, reading comprehension, and structured writing, progressing from sentences to short essays.',
  levels: ['F1', 'F2'] } });
const ch1 = (await call('t', 'POST', `/api/teacher/courses/${course.id}/chapters`, { body: { title: 'Chapter 1 · Building Blocks of English' } })).chapter;
const ch2 = (await call('t', 'POST', `/api/teacher/courses/${course.id}/chapters`, { body: { title: 'Chapter 2 · Comprehension & Expression' } })).chapter;

// materials: PDF reading + video lecture (raw uploads through the live API)
import { readFileSync } from 'node:fs';
const pdf = readFileSync('.tools/demo-worksheet.pdf');
await fetch(`${BASE}/api/teacher/chapters/${ch1.id}/materials?title=${encodeURIComponent('Reading Companion — Chapter 1')}&description=${encodeURIComponent('Printable companion sheet with practice tasks.')}&kind=pdf&allow_download=1&name=reading-companion.pdf`, {
  method: 'PUT', headers: { 'X-Requested-With': 'fetch', Cookie: cookie('t'), 'Content-Type': 'application/pdf' }, body: pdf });
const video = readFileSync('server/assets/welcome.mp4');
const vres = await fetch(`${BASE}/api/teacher/chapters/${ch1.id}/materials?title=${encodeURIComponent('Lecture — Why English Opens Doors')}&description=${encodeURIComponent('A short orientation lecture. Scrub, pause, and replay as often as you need.')}&kind=video&allow_download=0&name=lecture.mp4`, {
  method: 'PUT', headers: { 'X-Requested-With': 'fetch', Cookie: cookie('t'), 'Content-Type': 'video/mp4' }, body: video });
console.log('video upload:', vres.status);

// quiz: 2 MC + 1 DOC with worksheet attachment
const { quiz } = await call('t', 'POST', `/api/teacher/chapters/${ch2.id}/quizzes`, { body: {
  title: 'Placement Check: Reading & Writing',
  instructions: 'Two quick questions plus one short written task. You have two attempts. The written task is reviewed personally by your instructor.',
  time_limit_min: 10, max_attempts: 2, show_results: true } });
await call('t', 'POST', `/api/teacher/quizzes/${quiz.id}/questions`, { body: {
  type: 'mc', prompt: 'Which sentence is written correctly?', points: 2,
  options: [{ label: 'the market opens early', is_correct: false }, { label: 'The market opens early.', is_correct: true }, { label: 'the Market opens Early', is_correct: false }] } });
await call('t', 'POST', `/api/teacher/quizzes/${quiz.id}/questions`, { body: {
  type: 'mc', prompt: 'In “Fatima reads every evening,” what is the verb?', points: 2,
  options: [{ label: 'Fatima', is_correct: false }, { label: 'reads', is_correct: true }, { label: 'evening', is_correct: false }] } });
const ws = await fetch(`${BASE}/api/teacher/files/question?kind=attachment&name=writing-task-worksheet.pdf`, {
  method: 'PUT', headers: { 'X-Requested-With': 'fetch', Cookie: cookie('t'), 'Content-Type': 'application/pdf' }, body: pdf });
const { token } = await ws.json();
await call('t', 'POST', `/api/teacher/quizzes/${quiz.id}/questions`, { body: {
  type: 'doc', prompt: 'Read the attached worksheet and answer in your own words (3–5 sentences), or upload your answer as a file.',
  points: 6, attachment_token: token, attachment_name: 'writing-task-worksheet.pdf' } });

console.log(JSON.stringify({ seeded: true, course: course.id, teacher: 'hodan.abdi/Teacher@2026', student: 'amina.yusuf/Student@2026' }));
