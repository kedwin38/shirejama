// ── Course / chapter / material services (FR-4.1 … FR-4.5) ───────────────
import { badRequest, forbidden, notFound } from '../core/errors.js';
import { LEVELS } from '../config.js';
import { nowIso, reqString } from '../core/validate.js';
import { FileVault } from './files.js';

export class CourseService {
  constructor(db, vault) {
    this.db = db;
    this.vault = vault;
  }

  _owned(teacherId, courseId) {
    const c = this.db.prepare('SELECT * FROM courses WHERE id = ?').get(courseId);
    if (!c) throw notFound('Course not found.');
    if (c.teacher_id !== teacherId) throw forbidden('You can only manage courses you own.');
    return c;
  }

  _levels(courseId) {
    return this.db.prepare('SELECT level FROM course_levels WHERE course_id = ? ORDER BY level')
      .all(courseId).map((r) => r.level);
  }

  static cleanLevels(levels) {
    const arr = [...new Set(Array.isArray(levels) ? levels : [])];
    if (!arr.length) throw badRequest('A course must target at least one academic level.');
    for (const l of arr) if (!LEVELS.includes(l)) throw badRequest(`Unknown academic level "${l}".`);
    return arr.sort();
  }

  create(teacherId, { title, description, levels }) {
    const t = reqString(title, 'title', { min: 3, max: 160 });
    const d = typeof description === 'string' ? description.trim().slice(0, 2000) : '';
    const lvls = CourseService.cleanLevels(levels);
    return this.db.transaction(() => {
      const now = nowIso();
      const { lastId } = this.db.prepare(
        'INSERT INTO courses (teacher_id, title, description, created_at, updated_at) VALUES (?,?,?,?,?)'
      ).run(teacherId, t, d, now, now);
      const ins = this.db.prepare('INSERT INTO course_levels (course_id, level) VALUES (?,?)');
      for (const l of lvls) ins.run(lastId, l);
      return this.detail(teacherId, lastId, { authoring: true });
    });
  }

  update(teacherId, courseId, patch) {
    this._owned(teacherId, courseId);
    const fields = {};
    if (patch.title !== undefined) fields.title = reqString(patch.title, 'title', { min: 3, max: 160 });
    if (patch.description !== undefined) fields.description = String(patch.description ?? '').trim().slice(0, 2000);
    if (patch.levels !== undefined) fields._levels = CourseService.cleanLevels(patch.levels);
    if (!Object.keys(fields).length) throw badRequest('Nothing to update.');
    return this.db.transaction(() => {
      if (fields._levels) {
        this.db.prepare('DELETE FROM course_levels WHERE course_id = ?').run(courseId);
        const ins = this.db.prepare('INSERT INTO course_levels (course_id, level) VALUES (?,?)');
        for (const l of fields._levels) ins.run(courseId, l);
        delete fields._levels;
      }
      if (Object.keys(fields).length) {
        fields.updated_at = nowIso();
        const sets = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
        this.db.prepare(`UPDATE courses SET ${sets} WHERE id = ?`).run(...Object.values(fields), courseId);
      }
      return this.detail(teacherId, courseId, { authoring: true });
    });
  }

  /** FR-4.1 delete — real server-side cascade + file purge (never UI-only). */
  delete(teacherId, courseId) {
    this._owned(teacherId, courseId);
    const files = this.db.prepare(`
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
    `).all(courseId, courseId, courseId, courseId).map((r) => r.p).filter(Boolean);

    this.db.transaction(() => {
      this.db.prepare('DELETE FROM courses WHERE id = ?').run(courseId); // cascades everything
    });
    for (const f of files) this.vault.removeQuietly(f);
    return { ok: true };
  }

  listForTeacher(teacherId) {
    const courses = this.db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM chapters h WHERE h.course_id = c.id) chapter_count,
        (SELECT COUNT(*) FROM materials m JOIN chapters h ON h.id = m.chapter_id WHERE h.course_id = c.id) material_count,
        (SELECT COUNT(*) FROM quizzes z JOIN chapters h ON h.id = z.chapter_id WHERE h.course_id = c.id) quiz_count,
        (SELECT COUNT(*) FROM attempts t JOIN quizzes z ON z.id = t.quiz_id
           JOIN chapters h ON h.id = z.chapter_id WHERE h.course_id = c.id AND t.status = 'submitted') pending_grading
      FROM courses c WHERE c.teacher_id = ? ORDER BY c.updated_at DESC
    `).all(teacherId);
    return courses.map((c) => ({ ...c, levels: this._levels(c.id) }));
  }

  /** Full authoring tree: chapters → materials, quizzes → questions+options. */
  detail(teacherId, courseId, { authoring = true } = {}) {
    const course = this._owned(teacherId, courseId);
    const chapters = this.db.prepare(
      'SELECT * FROM chapters WHERE course_id = ? ORDER BY position, id'
    ).all(courseId);
    const mats = this.db.prepare(`
      SELECT m.* FROM materials m JOIN chapters h ON h.id = m.chapter_id
      WHERE h.course_id = ? ORDER BY m.created_at
    `).all(courseId);
    const quizzes = this.db.prepare(`
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
      const qs = this.db.prepare(`
        SELECT q.* FROM questions q JOIN quizzes z ON z.id = q.quiz_id
        WHERE z.chapter_id IN (SELECT id FROM chapters WHERE course_id = ?)
        ORDER BY q.position, q.id
      `).all(courseId);
      const opts = quizzes.length ? this.db.prepare(`
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
      levels: this._levels(courseId),
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
  addChapter(teacherId, courseId, title) {
    this._owned(teacherId, courseId);
    const t = reqString(title, 'chapter title', { min: 3, max: 160 });
    return this.db.transaction(() => {
      const max = this.db.prepare(
        'SELECT COALESCE(MAX(position),0) m FROM chapters WHERE course_id = ?'
      ).get(courseId).m;
      const { lastId } = this.db.prepare(
        'INSERT INTO chapters (course_id, title, position, created_at) VALUES (?,?,?,?)'
      ).run(courseId, t, max + 1, nowIso());
      return this.db.prepare('SELECT * FROM chapters WHERE id = ?').get(lastId);
    });
  }

  _chapterOwned(teacherId, chapterId) {
    const h = this.db.prepare(`
      SELECT h.*, c.teacher_id FROM chapters h JOIN courses c ON c.id = h.course_id WHERE h.id = ?
    `).get(chapterId);
    if (!h) throw notFound('Chapter not found.');
    if (h.teacher_id !== teacherId) throw forbidden('You can only manage your own courses.');
    return h;
  }

  renameChapter(teacherId, chapterId, title) {
    this._chapterOwned(teacherId, chapterId);
    const t = reqString(title, 'chapter title', { min: 3, max: 160 });
    this.db.prepare('UPDATE chapters SET title = ? WHERE id = ?').run(t, chapterId);
    return { ok: true };
  }

  deleteChapter(teacherId, chapterId) {
    this._chapterOwned(teacherId, chapterId);
    const files = this.db.prepare(`
      SELECT m.stored_path AS p FROM materials m WHERE m.chapter_id = ?
      UNION ALL SELECT q.image_path FROM questions q WHERE q.quiz_id IN (SELECT id FROM quizzes WHERE chapter_id = ?)
      UNION ALL SELECT q.attachment_path FROM questions q WHERE q.quiz_id IN (SELECT id FROM quizzes WHERE chapter_id = ?)
      UNION ALL SELECT a.file_path FROM answers a WHERE a.attempt_id IN
        (SELECT t.id FROM attempts t JOIN quizzes z ON z.id = t.quiz_id WHERE z.chapter_id = ?)
    `).all(chapterId, chapterId, chapterId, chapterId).map((r) => r.p).filter(Boolean);
    this.db.prepare('DELETE FROM chapters WHERE id = ?').run(chapterId); // cascades
    for (const f of files) this.vault.removeQuietly(f);
    return { ok: true };
  }

  moveChapter(teacherId, chapterId, dir) {
    const h = this._chapterOwned(teacherId, chapterId);
    const delta = dir === 'up' ? -1 : dir === 'down' ? 1 : null;
    if (!delta) throw badRequest('Move direction must be "up" or "down".');
    return this.db.transaction(() => {
      const neighbor = this.db.prepare(`
        SELECT * FROM chapters WHERE course_id = ? AND position ${delta < 0 ? '<' : '>'} ?
        ORDER BY position ${delta < 0 ? 'DESC' : 'ASC'} LIMIT 1
      `).get(h.course_id, h.position);
      if (!neighbor) return { ok: true, moved: false };
      const upd = this.db.prepare('UPDATE chapters SET position = ? WHERE id = ?');
      upd.run(h.position, neighbor.id);
      upd.run(neighbor.position, h.id);
      return { ok: true, moved: true };
    });
  }

  // ── Materials (FR-4.4 / FR-4.5) ─────────────────────────────────────────
  async addMaterial(teacherId, chapterId, meta, req) {
    const h = this._chapterOwned(teacherId, chapterId);
    const kind = meta.kind === 'video' ? 'video' : meta.kind === 'pdf' ? 'pdf' : null;
    if (!kind) throw badRequest('Material kind must be "pdf" or "video".');
    const title = reqString(meta.title, 'title', { min: 3, max: 160 });
    const description = String(meta.description ?? '').trim().slice(0, 1000);
    const allowDownload = meta.allow_download === '1' || meta.allow_download === 'true' ? 1 : 0;

    const rec = await this.vault.receive(req, kind, meta.name || title, {
      category: kind === 'pdf' ? 'materialPdf' : 'materialVideo',
    });
    const { lastId } = this.db.prepare(`
      INSERT INTO materials (chapter_id, kind, title, description, file_name, stored_path, mime, size_bytes, allow_download, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(chapterId, kind, title, description, rec.file_name, rec.stored_path, rec.mime, rec.size, allowDownload, nowIso());
    this.db.prepare('UPDATE courses SET updated_at = ? WHERE id = ?').run(nowIso(), h.course_id);
    return this.db.prepare('SELECT * FROM materials WHERE id = ?').get(lastId);
  }

  deleteMaterial(teacherId, materialId) {
    const m = this.db.prepare(`
      SELECT m.*, c.teacher_id FROM materials m
      JOIN chapters h ON h.id = m.chapter_id JOIN courses c ON c.id = h.course_id
      WHERE m.id = ?
    `).get(materialId);
    if (!m) throw notFound('Material not found.');
    if (m.teacher_id !== teacherId) throw forbidden('You can only manage your own courses.');
    this.db.prepare('DELETE FROM materials WHERE id = ?').run(materialId);
    this.vault.removeQuietly(m.stored_path);
    return { ok: true };
  }
}
