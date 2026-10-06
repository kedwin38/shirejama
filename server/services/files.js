// ── FileVault · secure blob storage (FR-6, ADR-003) ──────────────────────
// Every byte stored here is addressed by DB id, lives under an opaque UUID
// name, and is only ever emitted through permission-checked endpoints.
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../core/errors.js';
import { readRawBodyToFile } from '../kernel/http.js';
import { log } from '../core/log.js';

const readHead = (path, n = 32) => new Promise((resolve, reject) => {
  const s = createReadStream(path, { start: 0, end: n - 1 });
  const chunks = [];
  s.on('data', (c) => chunks.push(c));
  s.on('end', () => resolve(Buffer.concat(chunks)));
  s.on('error', reject);
});

const starts = (buf, bytes, off = 0) =>
  bytes.every((b, i) => buf[off + i] === b);

// Container sniffers (FR-4.4 / FR-5.6)
const sniff = {
  pdf: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  video: (b) => {
    // MP4 / MOV / M4V: “….ftyp” at offset 4
    if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') {
      const brand = b.subarray(8, 12).toString('latin1').toLowerCase();
      const ok = /^(isom|iso2|mp41|mp42|avc1|dash|msnv|m4v |qt  |qt00|3gp\d|heic|caaa)/.test(brand)
        || brand.startsWith('iso') || brand.startsWith('mp4') || brand.startsWith('avc');
      return ok;
    }
    // WebM/MKV: EBML magic 1A 45 DF A3
    if (starts(b, [0x1a, 0x45, 0xdf, 0xa3])) return true;
    return false;
  },
  image: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47])                    // PNG
    || starts(b, [0xff, 0xd8, 0xff])                                   // JPEG
    || (starts(b, [0x47, 0x49, 0x46, 0x38]))                           // GIF
    || (b.subarray(0, 4).toString('latin1') === 'RIFF'
        && b.subarray(8, 12).toString('latin1') === 'WEBP'),
  // Student answer uploads: PDF, legacy Word (OLE CFB), docx (zip), images
  answer: (b) => sniff.pdf(b)
    || starts(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])    // .doc/.xls/.ppt
    || starts(b, [0x50, 0x4b, 0x03, 0x04])                            // zip → docx
    || sniff.image(b),
};

const SAFE_EXT = /^[a-z0-9]{1,6}$/i;

export class FileVault {
  constructor(db, { stagingDir, subDirs, caps }) {
    this.db = db;
    this.staging = stagingDir;
    this.dirs = subDirs;
    this.caps = caps;
  }

  /**
   * Streams the request body to a staging file, validates magic bytes by
   * declared kind, then atomically renames into its final home.
   * Returns { stored_path, file_name, mime, size }.
   */
  async receive(req, kind, fileName, { category }) {
    const cap = this.caps[category];
    if (!cap) throw new AppError(500, 'internal_error', 'Unknown upload category.');
    const origName = String(fileName || 'file').replace(/[\r\n"\\/\u0000-\u001f]/g, '_').slice(0, 200);
    const extMatch = /\.([A-Za-z0-9]{1,6})$/.exec(origName);
    const ext = extMatch && SAFE_EXT.test(extMatch[1]) ? extMatch[1].toLowerCase() : 'bin';

    const staged = join(this.staging, `${randomUUID()}.part`);
    const { size } = await readRawBodyToFile(req, staged, cap);
    if (size === 0) {
      try { unlinkSync(staged); } catch {}
      throw new AppError(400, 'bad_request', 'The uploaded file is empty.');
    }

    let head;
    try { head = await readHead(staged); }
    catch (e) { throw new AppError(400, 'bad_request', 'Could not read the uploaded file.'); }

    const validators = {
      pdf: (b) => sniff.pdf(b),
      video: (b) => sniff.video(b),
      image: (b) => sniff.image(b),
      attachment: (b) => sniff.pdf(b) || sniff.image(b)
        || starts(b, [0xd0, 0xcf, 0x11, 0xe0]) || starts(b, [0x50, 0x4b, 0x03, 0x04]),
      answer: (b) => sniff.answer(b),
    };
    const validator = validators[kind];
    if (!validator || !validator(head)) {
      try { unlinkSync(staged); } catch {}
      throw new AppError(415, 'unsupported_media',
        kind === 'pdf' ? 'This file is not a valid PDF (its contents failed the PDF signature check).'
        : kind === 'video' ? 'This file is not a recognized video container (MP4, WebM, MOV…).'
        : kind === 'image' ? 'This file is not a recognized image (PNG, JPEG, GIF, WebP).'
        : 'This file type is not accepted here (allowed: PDF, Word documents, or images).');
    }

    const dir = {
      pdf: this.dirs.materials, video: this.dirs.materials,
      image: this.dirs.questions, attachment: this.dirs.questions,
      answer: this.dirs.answers,
    }[kind];
    const finalPath = join(dir, `${randomUUID()}.${ext}`);
    renameSync(staged, finalPath);

    const mime = ({
      pdf: 'application/pdf',
      video: ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : 'video/mp4',
      image: head[0] === 0x89 ? 'image/png' : head[0] === 0xff ? 'image/jpeg'
        : head[0] === 0x47 ? 'image/gif' : 'image/webp',
      attachment: sniff.pdf(head) ? 'application/pdf'
        : sniff.image(head) ? (head[0] === 0x89 ? 'image/png' : 'image/jpeg')
        : starts(head, [0x50, 0x4b]) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/msword',
      answer: sniff.pdf(head) ? 'application/pdf'
        : sniff.image(head) ? (head[0] === 0x89 ? 'image/png' : 'image/jpeg')
        : starts(head, [0x50, 0x4b]) ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/msword',
    })[kind];

    return { stored_path: finalPath, file_name: origName, mime, size };
  }

  /** Stage a question image/attachment; caller promotes it via promoteStaged(). */
  async stageQuestionFile(req, kind, fileName) {
    const rec = await this.receive(req, kind, fileName, {
      category: kind === 'image' ? 'questionImage' : 'questionAttachment',
    });
    // question files already live in the questions dir; token = stored name
    return { token: rec.stored_path, file_name: rec.file_name, mime: rec.mime, size: rec.size };
  }

  promoteStaged(token) {
    // tokens are server-generated absolute paths under our questions dir —
    // validate prefix to be safe against crafted values.
    if (!token || !token.startsWith(this.dirs.questions)) {
      throw new AppError(400, 'bad_request', 'Invalid file token.');
    }
    return token;
  }

  removeQuietly(path) {
    if (!path) return;
    try { unlinkSync(path); } catch (e) { if (e.code !== 'ENOENT') log.warn('file_unlink_failed', { path, err: e.code }); }
  }

  // ── Permission-resolving accessors (FR-6.2 / FR-6.3) ───────────────────

  /** Material + its course/levels for authorization. */
  materialContext(id) {
    return this.db.prepare(`
      SELECT m.*, c.teacher_id, c.id AS course_id, c.title AS course_title
      FROM materials m
      JOIN chapters ch ON ch.id = m.chapter_id
      JOIN courses  c  ON c.id  = ch.course_id
      WHERE m.id = ?
    `).get(id);
  }

  /** Question (+quiz→chapter→course chain) for image/attachment serving. */
  questionContext(id) {
    return this.db.prepare(`
      SELECT q.*, c.teacher_id, c.id AS course_id
      FROM questions q
      JOIN quizzes  z ON z.id = q.quiz_id
      JOIN chapters h ON h.id = z.chapter_id
      JOIN courses  c ON c.id = h.course_id
      WHERE q.id = ?
    `).get(id);
  }

  /** Student answer file + ownership chain. */
  answerContext(id) {
    return this.db.prepare(`
      SELECT a.file_path, a.file_name, a.id AS answer_id, a.attempt_id,
             a.question_id, at.student_id, c.teacher_id, c.id AS course_id
      FROM answers a
      JOIN attempts at ON at.id = a.attempt_id
      JOIN quizzes z  ON z.id  = at.quiz_id
      JOIN chapters h ON h.id  = z.chapter_id
      JOIN courses  c ON c.id  = h.course_id
      WHERE a.id = ? AND a.file_path IS NOT NULL
    `).get(id);
  }

  /** Course levels for a material/question's course (student gate). */
  courseLevels(courseId) {
    return this.db.prepare('SELECT level FROM course_levels WHERE course_id = ?')
      .all(courseId).map((r) => r.level);
  }
}
