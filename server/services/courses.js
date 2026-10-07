// ── Course / chapter / material services (FR-4.1 … FR-4.5) ───────────────
import { badRequest, forbidden, notFound } from '../core/errors.js';
import { LEVELS } from '../config.js';
import { nowIso, reqString } from '../core/validate.js';

export class CourseService {
  constructor(db, vault) {
    this.db = db;
    this.vault = vault;
  }

  async _owned(teacherId, courseId) {
    const c = await this.db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
    if (!c) throw notFound('Course not found.');
    if (c.teacher_id !== teacherId) throw forbidden('You can only manage courses you own.');
    return c;
  }

  async _levels(courseId) {
    const rows = await this.db.prepare('SELECT level FROM course_levels WHERE course_id = ? ORDER BY level')
      .all(courseId);
    return rows.map((r) => r.level);
  }

  static cleanLevels(levels) {
    const arr = [...new Set(Array.isArray(levels) ? levels : [])];
    if (!arr.length) throw badRequest('A course must target at least one academic level.');
    for (const l of arr) if (!LEVELS.includes(l)) throw badRequest(`Unknown academic level "${l}".`);
    return arr.sort();
  }

  async create(teacherId, { title, description, levels }) {
    const t = reqString(title, 'title', { min: 3, max: 160 });
    const d = typeof description === 'string' ? description.trim().slice(0, 2000) : '';
    const lvls = CourseService.cleanLevels(levels);
    let lastId;
    try {
      return await this.db.transaction(async () => {
        const now = nowIso();
        ({ lastId } = await this.db.prepare(
          'INSERT INTO courses (teacher_id, title, description, created_at, updated_at) VALUES (?,?,?,?,?)'
        ).run(teacherId, t, d, now, now));
        const ins = this.db.prepare('INSERT INTO course_levels (course_id, level) VALUES (?,?)');
        for (const l of lvls) await ins.run(lastId, l);
        return await this.detail(teacherId, lastId, { authoring: true });
      });
    } catch (e) {
      // D1 has no interactive rollback — compensate for a partial write so a
      // mid-transaction failure never leaves an orphaned course behind.
      if (lastId != null) await this.db.prepare('DELETE FROM courses WHERE id = ?').run(lastId).catch(() => {});
      throw e;
    }
  }

  async update(teacherId, courseId, patch) {
    await this._owned(teacherId, courseId);
    const fields = {};
    if (patch.title !== undefined) fields.title = reqString(patch.title, 'title', { min: 3, max: 160 });
    if (patch.description !== undefined) fields.description = String(patch.description ?? '').trim().slice(0, 2000);
    if (patch.levels !== undefined) fields._levels = CourseService.cleanLevels(patch.levels);
    if (!Object.keys(fields).length) throw badRequest('Nothing to update.');
    return await this.db.transaction(async () => {
      if (fields._levels) {
        await this.db.prepare('DELETE FROM course_levels WHERE course_id = ?').run(courseId);
        const ins = this.db.prepare('INSERT INTO course_levels (course_id, level) VALUES (?,?)');
        for (const l of fields._levels) await ins.run(courseId, l);
        delete fields._levels;
      }
      if (Object.keys(fields).length) {
        fields.updated_at = nowIso();
        const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
        await this.db.prepare(`UPDATE courses SET ${sets} WHERE id = ?`).run(...Object.values(fields), courseId);
      }
      return await this.detail(teacherId, courseId, { authoring: true });
    });
  }

  /** FR-4.1 delete — real server-side cascade + file purge (never UI-only). */
  async delete(teacherId, courseId) {
    await this._owned(teacherId, courseId);
    const rows = await this.db.prepare(`
      SELECT stored_path AS p FROM materials WHERE chapter_id IN
        (SELECT id FROM chapters WHERE course_id = ?)
      UNION ALL
      SELECT image_path FROM questions WHERE quiz_id IN
        (SELECT id FROM quizzes WHERE chapter_id IN (SELECT id FROM chapters WHERE course_id = ?))
      UNION ALL
      SELECT attachment_path FROM questions WHERE quiz_id IN
        (SELECT id FROM quizzes WHERE chapter_id IN (SELECT id FROM chapters WHERE course_id = ?))
      UNION ALL
      SELECT a.file_path FROM answers a JOIN attempts t ON t.id = a.attempt_id
        WHERE t.quiz_id IN (SELECT id FROM quizzes WHERE chapter_id IN (SELECT id FROM chapters WHERE course_id = ?))
    `).all(courseId, courseId, courseId, courseId);
    const files = rows.map((r) => r.p).filter(Boolean);

    await this.db.transaction(async () => {
      await this.db.prepare('DELETE FROM courses WHERE id = ?').run(courseId); // cascades everything
    });
    for (const f of files) await this.vault.removeQuietly(f);
    return { ok: true };
  }

  async listForTeacher(teacherId) {
    const courses = await this.db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM chapters h WHERE h.course_id = c.id) chapter_count,
        (SELECT COUNT(*) FROM materials m JOIN chapters h ON h.id = m.chapter_id WHERE h.course_id = c.id) material_count,
        (SELECT COUNT(*) FROM quizzes z JOIN chapters h ON h.id = z.chapter_id WHERE h.course_id = c.id) quiz_count,
        (SELECT COUNT(*) FROM attempts t JOIN quizzes z ON z.id = t.quiz_id
           JOIN chapters h ON h.id = z.chapter_id WHERE h.course_id = c.id AND t.status = 'submitted') pending_grading
      FROM courses c WHERE c.teacher_id = ? ORDER BY c.updated_at DESC
    `).all(teacherId);
    const out = [];
    for (const c of courses) out.push({ ...c, levels: await this._levels(c.id) });
    return out;
  }

  /** Full authoring tree: chapters → materials, quizzes → questions+options. */
  async detail(teacherId, courseId, { authoring = true } = {}) {
    const course = await this._owned(teacherId, courseId);
    const chapters = await this.db.prepare(
      'SELECT * FROM chapters WHERE course_id = ? ORDER BY position, id'
    ).all(courseId);
    const mats = await this.db.prepare(`
      SELECT m.* FROM materials m JOIN chapters h ON h.id = m.chapter_id
      WHERE h.course_id = ? ORDER BY m.created_at
    `).all(courseId);
    const quizzes = await this.db.prepare(`
      SELECT z.* FROM quizzes z JOIN chapters h ON h.id = z.chapter_id
      WHERE h.course_id = ? ORDER BY z.created_at
    `).all(courseId);
    const byChapter = (rows) => {
      const map = {};
      for (const r of rows) (map[r.chapter_id] ??= []).push(r);
      return map;
    };
    const matBy = byChapter(mats), quizBy = byChapter(quizzes);

    let questions = [];
    if (authoring && quizzes.length) {
      const qs = await this.db.prepare(`
        SELECT q.* FROM questions q JOIN quizzes z ON z.id = q.quiz_id
        WHERE z.chapter_id IN (SELECT id FROM chapters WHERE course_id = ?)
        ORDER BY q.position, q.id
      `).all(courseId);
      const opts = quizzes.length ? await this.db.prepare(`
        SELECT o.* FROM options o JOIN questions q ON q.id = o.question_id
        WHERE q.quiz_id IN (${quizzes.map(() => '?').join(',')})
        ORDER BY o.position, o.id
      `).all(...quizzes.map((z) => z.id)) : [];
      const optBy = {};
      for (const o of opts) (optBy[o.question_id] ??= []).push(
        { id: o.id, label: o.label, is_correct: !!o.is_correct, position: o.position });
      questions = qs.map((q) => ({
        ...q,
        has_image: !!q.image_path,
        has_attachment: !!q.attachment_path,
        options: optBy[q.id] ?? [],
      }));
    }
    const qBy = {};
    for (const q of questions) (qBy[q.quiz_id] ??= []).push(q);

    return {
      ...course,
      levels: await this._levels(courseId),
      chapters: chapters.map((h) => ({
        ...h,
        materials: (matBy[h.id] ?? []).map((m) => ({ ...m, allow_download: !!m.allow_download })),
        quizzes: (quizBy[h.id] ?? []).map((z) => ({
          ...z,
          show_results: !!z.show_results,
          question_count: (qBy[z.id] ?? []).length,
          has_document_questions: (qBy[z.id] ?? []).some((q) => q.type === 'doc'),
          questions: (qBy[z.id] ?? []),
        })),
      })),
    };
  }

  // ── Chapters (FR-4.3) ───────────────────────────────────────────────────
  async addChapter(teacherId, courseId, title) {
    await this._owned(teacherId, courseId);
    const t = reqString(title, 'chapter title', { min: 3, max: 160 });
    return await this.db.transaction(async () => {
      const row = await this.db.prepare(
        'SELECT COALESCE(MAX(position),0) m FROM chapters WHERE course_id = ?'
      ).get(courseId);
      const { lastId } = await this.db.prepare(
        'INSERT INTO chapters (course_id, title, position, created_at) VALUES (?,?,?,?)'
      ).run(courseId, t, row.m + 1, nowIso());
      return await this.db.prepare('SELECT * FROM chapters WHERE id = ?').get(lastId);
    });
  }

  async _chapterOwned(teacherId, chapterId) {
    const h = await this.db.prepare(`
      SELECT h.*, c.teacher_id FROM chapters h JOIN courses c ON c.id = h.course_id WHERE h.id = ?
    `).get(chapterId);
    if (!h) throw notFound('Chapter not found.');
    if (h.teacher_id !== teacherId) throw forbidden('You can only manage your own courses.');
    return h;
  }

  async renameChapter(teacherId, chapterId, title) {
    await this._chapterOwned(teacherId, chapterId);
    const t = reqString(title, 'chapter title', { min: 3, max: 160 });
    await this.db.prepare('UPDATE chapters SET title = ? WHERE id = ?').run(t, chapterId);
    return { ok: true };
  }

  async deleteChapter(teacherId, chapterId) {
    await this._chapterOwned(teacherId, chapterId);
    const rows = await this.db.prepare(`
      SELECT m.stored_path AS p FROM materials m WHERE m.chapter_id = ?
      UNION ALL SELECT q.image_path FROM questions q WHERE q.quiz_id IN (SELECT id FROM quizzes WHERE chapter_id = ?)
      UNION ALL SELECT q.attachment_path FROM questions q WHERE q.quiz_id IN (SELECT id FROM quizzes WHERE chapter_id = ?)
      UNION ALL SELECT a.file_path FROM answers a WHERE a.attempt_id IN
        (SELECT t.id FROM attempts t JOIN quizzes z ON z.id = t.quiz_id WHERE z.chapter_id = ?)
    `).all(chapterId, chapterId, chapterId, chapterId);
    const files = rows.map((r) => r.p).filter(Boolean);
    await this.db.prepare('DELETE FROM chapters WHERE id = ?').run(chapterId); // cascades
    for (const f of files) await this.vault.removeQuietly(f);
    return { ok: true };
  }

  async moveChapter(teacherId, chapterId, dir) {
    const h = await this._chapterOwned(teacherId, chapterId);
    const delta = dir === 'up' ? -1 : dir === 'down' ? 1 : null;
    if (!delta) throw badRequest('Move direction must be "up" or "down".');
    return await this.db.transaction(async () => {
      const neighbor = await this.db.prepare(`
        SELECT * FROM chapters WHERE course_id = ? AND position ${delta < 0 ? '<' : '>'} ?
        ORDER BY position ${delta < 0 ? 'DESC' : 'ASC'} LIMIT 1
      `).get(h.course_id, h.position);
      if (!neighbor) return { ok: true, moved: false };
      const upd = this.db.prepare('UPDATE chapters SET position = ? WHERE id = ?');
      await upd.run(h.position, neighbor.id);
      await upd.run(neighbor.position, h.id);
      return { ok: true, moved: true };
    });
  }

  // ── Materials (FR-4.4 / FR-4.5) ─────────────────────────────────────────
  async addMaterial(teacherId, chapterId, meta, req) {
    const h = await this._chapterOwned(teacherId, chapterId);
    const kind = meta.kind === 'video' ? 'video' : meta.kind === 'pdf' ? 'pdf' : null;
    if (!kind) throw badRequest('Material kind must be "pdf" or "video".');
    const title = reqString(meta.title, 'title', { min: 3, max: 160 });
    const description = String(meta.description ?? '').trim().slice(0, 1000);
    const allowDownload = meta.allow_download === '1' || meta.allow_download === 'true' ? 1 : 0;

    const rec = await this.vault.receive(req, kind, meta.name || title, {
      category: kind === 'pdf' ? 'materialPdf' : 'materialVideo',
    });
    const { lastId } = await this.db.prepare(`
      INSERT INTO materials (chapter_id, kind, title, description, file_name, stored_path, mime, size_bytes, allow_download, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(chapterId, kind, title, description, rec.file_name, rec.stored_path, rec.mime, rec.size, allowDownload, nowIso());
    await this.db.prepare('UPDATE courses SET updated_at = ? WHERE id = ?').run(nowIso(), h.course_id);
    return await this.db.prepare('SELECT * FROM materials WHERE id = ?').get(lastId);
  }

  async deleteMaterial(teacherId, materialId) {
    const m = await this.db.prepare(`
      SELECT m.*, c.teacher_id FROM materials m
      JOIN chapters h ON h.id = m.chapter_id JOIN courses c ON c.id = h.course_id
      WHERE m.id = ?
    `).get(materialId);
    if (!m) throw notFound('Material not found.');
    if (m.teacher_id !== teacherId) throw forbidden('You can only manage your own courses.');
    await this.db.prepare('DELETE FROM materials WHERE id = ?').run(materialId);
    await this.vault.removeQuietly(m.stored_path);
    return { ok: true };
  }
}
