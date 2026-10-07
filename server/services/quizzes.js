// ── Quiz authoring service (FR-4.6 / FR-4.7) ─────────────────────────────
import { badRequest, forbidden, notFound } from '../core/errors.js';
import { nowIso, reqString, reqInt, optIsoDate, optString } from '../core/validate.js';

export class QuizService {
  constructor(db, vault) {
    this.db = db;
    this.vault = vault;
  }

  async _quizOwned(teacherId, quizId) {
    const z = await this.db.prepare(`
      SELECT z.*, c.teacher_id, c.id AS course_id, c.title AS course_title
      FROM quizzes z
      JOIN chapters h ON h.id = z.chapter_id
      JOIN courses  c ON c.id  = h.course_id
      WHERE z.id = ?
    `).get(quizId);
    if (!z) throw notFound('Quiz not found.');
    if (z.teacher_id !== teacherId) throw forbidden('You can only manage your own quizzes.');
    return z;
  }

  _quizFields(body) {
    return {
      title: reqString(body.title, 'quiz title', { min: 3, max: 160 }),
      instructions: optString(body.instructions, { max: 2000 }),
      time_limit_min: reqInt(body.time_limit_min, 'time limit', { min: 1, max: 600, nullable: true }),
      opens_at: optIsoDate(body.opens_at, 'opens at'),
      closes_at: optIsoDate(body.closes_at, 'closes at'),
      max_attempts: reqInt(body.max_attempts, 'max attempts', { min: 1, max: 100, nullable: true }),
      show_results: body.show_results ? 1 : 0,
    };
  }

  async create(teacherId, chapterId, body) {
    const h = await this.db.prepare(`
      SELECT h.*, c.teacher_id FROM chapters h JOIN courses c ON c.id = h.course_id WHERE h.id = ?
    `).get(chapterId);
    if (!h) throw notFound('Chapter not found.');
    if (h.teacher_id !== teacherId) throw forbidden('You can only manage your own courses.');
    const f = this._quizFields(body);
    const now = nowIso();
    const { lastId } = await this.db.prepare(`
      INSERT INTO quizzes (chapter_id, title, instructions, time_limit_min, opens_at, closes_at, max_attempts, show_results, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(chapterId, f.title, f.instructions, f.time_limit_min, f.opens_at, f.closes_at,
             f.max_attempts, f.show_results, now, now);
    return await this.db.prepare('SELECT * FROM quizzes WHERE id = ?').get(lastId);
  }

  async update(teacherId, quizId, body) {
    await this._quizOwned(teacherId, quizId);
    const f = this._quizFields(body);
    await this.db.prepare(`
      UPDATE quizzes SET title=?, instructions=?, time_limit_min=?, opens_at=?, closes_at=?, max_attempts=?, show_results=?, updated_at=?
      WHERE id = ?
    `).run(f.title, f.instructions, f.time_limit_min, f.opens_at, f.closes_at,
           f.max_attempts, f.show_results, nowIso(), quizId);
    return await this.db.prepare('SELECT * FROM quizzes WHERE id = ?').get(quizId);
  }

  async delete(teacherId, quizId) {
    await this._quizOwned(teacherId, quizId);
    const rows = await this.db.prepare(`
      SELECT image_path AS p FROM questions WHERE quiz_id = ? AND image_path IS NOT NULL
      UNION ALL SELECT attachment_path FROM questions WHERE quiz_id = ? AND attachment_path IS NOT NULL
      UNION ALL SELECT a.file_path FROM answers a WHERE a.attempt_id IN (SELECT id FROM attempts WHERE quiz_id = ?)
    `).all(quizId, quizId, quizId);
    const files = rows.map((r) => r.p).filter(Boolean);
    await this.db.prepare('DELETE FROM quizzes WHERE id = ?').run(quizId); // cascades attempts→answers
    for (const f of files) await this.vault.removeQuietly(f);
    return { ok: true };
  }

  /** FR-4.7 — add a question (MC with options / DOC with attachment). */
  async addQuestion(teacherId, quizId, body) {
    await this._quizOwned(teacherId, quizId);
    const type = body.type === 'mc' || body.type === 'doc' ? body.type : null;
    if (!type) throw badRequest('Question type must be "mc" or "doc".');
    const prompt = reqString(body.prompt, 'question prompt', { min: 3, max: 4000 });
    const points = reqInt(body.points ?? 1, 'points', { min: 1, max: 100 });

    let imageToken = null, attachToken = null, attachName = null;
    if (type === 'mc') {
      if (body.image_token) imageToken = this.vault.promoteStaged(body.image_token);
    } else {
      if (body.attachment_token) {
        attachToken = this.vault.promoteStaged(body.attachment_token);
        attachName = optString(body.attachment_name ?? 'attachment.pdf', { max: 200 });
      }
    }

    return await this.db.transaction(async () => {
      const row = await this.db.prepare(
        'SELECT COALESCE(MAX(position),0) m FROM questions WHERE quiz_id = ?'
      ).get(quizId);
      const { lastId } = await this.db.prepare(`
        INSERT INTO questions (quiz_id, type, prompt, points, image_path, attachment_path, attachment_name, position)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(quizId, type, prompt, points, imageToken, attachToken, attachName, row.m + 1);

      if (type === 'mc') {
        const opts = Array.isArray(body.options) ? body.options : [];
        const clean = opts.map((o) => ({
          label: reqString(o?.label, 'answer option', { min: 1, max: 500 }),
          correct: !!o?.is_correct,
        }));
        if (clean.length < 2) throw badRequest('A multiple-choice question needs at least two answer options.');
        if (clean.filter((o) => o.correct).length !== 1) {
          throw badRequest('Mark exactly one answer option as the correct answer.');
        }
        const ins = this.db.prepare(
          'INSERT INTO options (question_id, label, is_correct, position) VALUES (?,?,?,?)');
        let i = 0;
        for (const o of clean) await ins.run(lastId, o.label, o.correct ? 1 : 0, ++i);
      }
      await this.db.prepare('UPDATE quizzes SET updated_at = ? WHERE id = ?').run(nowIso(), quizId);
      return await this._question(lastId);
    });
  }

  async _question(id) {
    const q = await this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
    if (!q) throw notFound('Question not found.');
    const opts = await this.db.prepare(
      'SELECT id, label, is_correct, position FROM options WHERE question_id = ? ORDER BY position').all(id);
    return {
      ...q,
      has_image: !!q.image_path,
      has_attachment: !!q.attachment_path,
      options: opts.map((o) => ({ ...o, is_correct: !!o.is_correct })),
    };
  }

  async deleteQuestion(teacherId, questionId) {
    const q = await this.db.prepare(`
      SELECT q.*, c.teacher_id FROM questions q
      JOIN quizzes z ON z.id = q.quiz_id JOIN chapters h ON h.id = z.chapter_id
      JOIN courses c ON c.id = h.course_id WHERE q.id = ?
    `).get(questionId);
    if (!q) throw notFound('Question not found.');
    if (q.teacher_id !== teacherId) throw forbidden('You can only manage your own quizzes.');
    await this.db.prepare('DELETE FROM questions WHERE id = ?').run(questionId); // cascades options+answers
    await this.vault.removeQuietly(q.image_path);
    await this.vault.removeQuietly(q.attachment_path);
    return { ok: true };
  }
}
