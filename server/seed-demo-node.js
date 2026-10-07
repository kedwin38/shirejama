// ── Full demo dataset (Node only — writes sample PDF/video to local disk) ─
import { mkdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import config from './config.js';
import { hashPassword } from './core/passwords.js';
import { nowIso } from './core/validate.js';
import { generateUsername } from './core/ids.js';
import { makePdf } from './seed-libs.js';

/** Full demo dataset (teacher, student, course, materials, quiz). Skips if present. */
export async function seedDemo(db) {
  const already = await db.prepare("SELECT 1 FROM users WHERE role='teacher' LIMIT 1").get();
  if (already) return { seeded: false };

  const now = nowIso();
  const mkUser = async (role, name, email, extra = {}) => {
    const { lastId } = await db.prepare(`
      INSERT INTO users (role, full_name, username, email, password_hash, is_active,
                         instructor_code, student_id, academic_level, created_at, updated_at)
      VALUES (?,?,?,?,?,1,?,?,?,?,?)
    `).run(role, name, await generateUsername(db, name), email,
           hashPassword(extra.password), extra.instructor_code ?? null,
           extra.student_id ?? null, extra.academic_level ?? null, now, now);
    return lastId;
  };

  const teacherId = await mkUser('teacher', 'Hodan Abdi', 'hodan.abdi@shirejama.school', {
    instructor_code: 'INST-101', password: 'Teacher@2026',
  });
  const studentId = await mkUser('student', 'Amina Yusuf', 'amina.yusuf@shirejama.school', {
    student_id: `STD-${new Date().getUTCFullYear()}-1001`,
    academic_level: 'F1', password: 'Student@2026',
  });

  // Course
  const { lastId: courseId } = await db.prepare(`
    INSERT INTO courses (teacher_id, title, description, created_at, updated_at)
    VALUES (?,?,?,?,?)
  `).run(teacherId, 'English Foundations: Reading & Writing',
    'A grounding in practical English for adult learners — grammar, reading '
  + 'comprehension, and structured writing, progressing from sentences to '
  + 'short essays.', now, now);
  await db.prepare('INSERT INTO course_levels (course_id, level) VALUES (?,?)').run(courseId, 'F1');
  await db.prepare('INSERT INTO course_levels (course_id, level) VALUES (?,?)').run(courseId, 'F2');

  const ch = async (title, pos) => (await db.prepare(
    'INSERT INTO chapters (course_id, title, position, created_at) VALUES (?,?,?,?)'
  ).run(courseId, title, pos, now)).lastId;
  const ch1 = await ch('Chapter 1 · Building Blocks of English', 1);
  const ch2 = await ch('Chapter 2 · Comprehension & Expression', 2);

  // Materials: generated PDF + bundled sample video
  const matDir = config.subDirs.materials;
  mkdirSync(matDir, { recursive: true });
  const pdfBytes = makePdf({
    title: 'Reading & Writing — Chapter 1 Companion',
    subtitle: 'Shire Jama LMS · English Foundations · Generated course material',
    lines: [
      '# Welcome, learner',
      'This companion sheet accompanies Chapter 1 of English Foundations.',
      'Work through it after watching the video lecture, then mark the',
      'chapter as done on your course page.',
      '',
      '# The sentence',
      'A sentence expresses a complete thought. It begins with a capital',
      'letter and ends with a full stop, a question mark, or an exclamation.',
      '',
      '# Practice',
      '1. Rewrite: (the market opens early) as a full sentence.',
      '2. Find the subject and verb: “Fatima reads every evening.”',
      '3. Write three sentences about your own morning routine.',
      '',
      '"Education without limits." — Shire Jama\'a Ahmed Adult School',
    ],
  });
  writeFileSync(join(matDir, 'seed-reading-companion.pdf'), pdfBytes);
  await db.prepare(`
    INSERT INTO materials (chapter_id, kind, title, description, file_name, stored_path, mime, size_bytes, allow_download, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(ch1, 'pdf', 'Reading Companion — Chapter 1',
    'Printable companion sheet: sentences, subjects and verbs, with practice tasks.',
    'reading-companion.pdf', join(matDir, 'seed-reading-companion.pdf'),
    'application/pdf', pdfBytes.length, 1, now);

  try {
    const videoSrc = join(config.serverAssets, 'welcome.mp4');
    const videoDest = join(matDir, 'seed-lecture.mp4');
    copyFileSync(videoSrc, videoDest);
    const size = statSync(videoDest).size;
    await db.prepare(`
      INSERT INTO materials (chapter_id, kind, title, description, file_name, stored_path, mime, size_bytes, allow_download, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(ch1, 'video', 'Lecture — Why English Opens Doors',
      'A short orientation lecture. Scrub, pause, and replay as often as you need.',
      'lecture.mp4', videoDest, 'video/mp4', size, 0, now);
  } catch (e) {
    console.warn('seed: sample video skipped:', e.message);
  }

  // Quiz: 2 MC + 1 DOC (attachment PDF)
  const { lastId: quizId } = await db.prepare(`    INSERT INTO quizzes (chapter_id, title, instructions, time_limit_min, opens_at, closes_at, max_attempts, show_results, created_at, updated_at)
    VALUES (?,?,?,?,NULL,NULL,2,1,?,?)
  `).run(ch2, 'Placement Check: Reading & Writing',
    'Two quick questions plus one short written task. You have two attempts. '
  + 'The written task is reviewed personally by your instructor.',
    10, now, now);

  const qDir = config.subDirs.questions;
  mkdirSync(qDir, { recursive: true });
  const worksheet = makePdf({
    title: 'Short Writing Task',
    subtitle: 'Placement Check · Document question attachment',
    lines: [
      '# Instructions',
      'Read the passage below, then answer in the quiz.',
      '',
      '# Passage',
      'Amina moved to the city in spring. Every morning before work, she',
      'studied English for one hour. By winter, she could write a full',
      'letter to her sister without help.',
      '',
      '# Task',
      'In 3–5 sentences, explain how Amina progressed — and what her ',
      'routine can teach us about learning as an adult.',
    ],
  });
  writeFileSync(join(qDir, 'seed-worksheet.pdf'), worksheet);

  const insQ = db.prepare(`
    INSERT INTO questions (quiz_id, type, prompt, points, image_path, attachment_path, attachment_name, position)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  const insO = db.prepare('INSERT INTO options (question_id, label, is_correct, position) VALUES (?,?,?,?)');
  const q1 = (await insQ.run(quizId, 'mc',
    'Which sentence is written correctly?', 2, null, null, null, 1)).lastId;
  await insO.run(q1, 'the market opens early', 0, 1);
  await insO.run(q1, 'The market opens early.', 1, 2);
  await insO.run(q1, 'the Market opens Early', 0, 3);
  const q2 = (await insQ.run(quizId, 'mc',
    'In “Fatima reads every evening,” what is the verb?', 2, null, null, null, 2)).lastId;
  await insO.run(q2, 'Fatima', 0, 1);
  await insO.run(q2, 'reads', 1, 2);
  await insO.run(q2, 'evening', 0, 3);
  await insQ.run(quizId, 'doc',
    'Read the attached worksheet and answer in your own words (3–5 sentences), or upload your answer as a file.',
    6, null, join(qDir, 'seed-worksheet.pdf'), 'writing-task-worksheet.pdf', 3);

  return { seeded: true };
}

if (process.argv.includes('--run')) {
  const { DatabasePort } = await import('./core/db.js');
  const { readFileSync } = await import('node:fs');
  const { seedAdmin } = await import('./seed.js');
  mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabasePort(config.dbFile);
  db.exec(readFileSync(join(config.root, 'server', 'schema.sql'), 'utf8'));
  console.log(JSON.stringify(await seedAdmin(db)));
  if (config.seedDemo) console.log(JSON.stringify(await seedDemo(db)));
}
