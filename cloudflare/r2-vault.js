// ── FileVault · R2-backed blob storage (FR-6, ADR-003 Worker variant) ────
// Same public interface as server/services/files.js's FileVault — routes
// and services call it identically on both runtimes. Streams straight into
// R2 (never buffered in memory — a 2 GB lecture must not blow the isolate's
// heap), magic-byte validated via a tee()'d branch of the body.
import { randomUUID } from 'node:crypto';
import { AppError } from '../server/core/errors.js';
import { log } from '../server/core/log.js';

const starts = (buf, bytes, off = 0) => bytes.every((b, i) => buf[off + i] === b);

const sniff = {
  pdf: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  video: (b) => {
    if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp') {
      const brand = b.subarray(8, 12).toString('latin1').toLowerCase();
      return /^(isom|iso2|mp41|mp42|avc1|dash|msnv|m4v |qt  |qt00|3gp\d|heic|caaa)/.test(brand)
        || brand.startsWith('iso') || brand.startsWith('mp4') || brand.startsWith('avc');
    }
    if (starts(b, [0x1a, 0x45, 0xdf, 0xa3])) return true; // WebM/MKV EBML magic
    return false;
  },
  image: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47])
    || starts(b, [0xff, 0xd8, 0xff])
    || starts(b, [0x47, 0x49, 0x46, 0x38])
    || (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'),
  answer: (b) => sniff.pdf(b)
    || starts(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    || starts(b, [0x50, 0x4b, 0x03, 0x04])
    || sniff.image(b),
};

const SAFE_EXT = /^[a-z0-9]{1,6}$/i;
const PREFIX = { materials: 'materials', questions: 'questions', answers: 'answers' };

/**
 * Reads up to n bytes from a ReadableStreamDefaultReader for signature
 * sniffing. The reader belongs to one independent branch of a tee()'d
 * stream, so reading (and later cancelling) it has no effect on the other
 * branch — that branch still sees every byte from the start.
 */
async function peek(reader, n) {
  const chunks = [];
  let total = 0;
  while (total < n) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return { head: buf.subarray(0, Math.min(n, total)) };
}

/** Wraps a stream so it errors once more than capBytes have passed through. */
function capStream(stream, capBytes, onOverflow) {
  let seen = 0;
  const counter = new TransformStream({
    transform(chunk, controller) {
      seen += chunk.length;
      if (seen > capBytes) { controller.error(onOverflow()); return; }
      controller.enqueue(chunk);
    },
  });
  return stream.pipeThrough(counter);
}

export class R2Vault {
  constructor(db, bucket, caps) {
    this.db = db;
    this.bucket = bucket;
    this.caps = caps;
  }

  /**
   * Streams the request body into R2, magic-byte validated by kind.
   * Returns { stored_path (R2 key), file_name, mime, size }.
   */
  async receive(req, kind, fileName, { category }) {
    const cap = this.caps[category];
    if (!cap) throw new AppError(500, 'internal_error', 'Unknown upload category.');
    const len = Number(req.headers.get('content-length') || 0);
    if (len > cap) {
      throw new AppError(413, 'payload_too_large',
        `File exceeds the maximum permitted size of ${Math.floor(cap / 1024 / 1024)} MB.`);
    }
    if (!req.body) throw new AppError(400, 'bad_request', 'The uploaded file is empty.');

    const origName = String(fileName || 'file').replace(/[\r\n"\\/\u0000-\u001f]/g, '_').slice(0, 200);
    const extMatch = /\.([A-Za-z0-9]{1,6})$/.exec(origName);
    const ext = extMatch && SAFE_EXT.test(extMatch[1]) ? extMatch[1].toLowerCase() : 'bin';

    const [sniffBranch, storeBranch] = req.body.tee();
    const reader = sniffBranch.getReader();
    const { head } = await peek(reader, 32);
    reader.cancel().catch(() => {});

    if (head.length === 0) throw new AppError(400, 'bad_request', 'The uploaded file is empty.');

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
      await storeBranch.pipeTo(new WritableStream()).catch(() => {}); // drain, don't store
      throw new AppError(415, 'unsupported_media',
        kind === 'pdf' ? 'This file is not a valid PDF (its contents failed the PDF signature check).'
        : kind === 'video' ? 'This file is not a recognized video container (MP4, WebM, MOV…).'
        : kind === 'image' ? 'This file is not a recognized image (PNG, JPEG, GIF, WebP).'
        : 'This file type is not accepted here (allowed: PDF, Word documents, or images).');
    }

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

    const dir = { pdf: PREFIX.materials, video: PREFIX.materials,
      image: PREFIX.questions, attachment: PREFIX.questions, answer: PREFIX.answers }[kind];
    const key = `${dir}/${randomUUID()}.${ext}`;

    const capped = capStream(storeBranch, cap, () =>
      new AppError(413, 'payload_too_large', `File exceeds the maximum permitted size of ${Math.floor(cap / 1024 / 1024)} MB.`));

    let size;
    try {
      const put = await this.bucket.put(key, capped, { httpMetadata: { contentType: mime } });
      size = put.size;
    } catch (e) {
      await this.bucket.delete(key).catch(() => {});
      throw e instanceof AppError ? e : new AppError(413, 'payload_too_large', e.message);
    }
    return { stored_path: key, file_name: origName, mime, size };
  }

  /** Stage a question image/attachment; caller promotes it via promoteStaged(). */
  async stageQuestionFile(req, kind, fileName) {
    const rec = await this.receive(req, kind, fileName, {
      category: kind === 'image' ? 'questionImage' : 'questionAttachment',
    });
    return { token: rec.stored_path, file_name: rec.file_name, mime: rec.mime, size: rec.size };
  }

  promoteStaged(token) {
    // R2 put() is atomic — "staged" question files already live at their
    // final key; this only validates the token's shape.
    if (!token || !token.startsWith(`${PREFIX.questions}/`)) {
      throw new AppError(400, 'bad_request', 'Invalid file token.');
    }
    return token;
  }

  async removeQuietly(key) {
    if (!key) return;
    try { await this.bucket.delete(key); }
    catch (e) { log.warn('r2_delete_failed', { key, err: e.message }); }
  }

  // ── Permission-resolving accessors (FR-6.2 / FR-6.3) ───────────────────

  async materialContext(id) {
    return await this.db.prepare(`
      SELECT m.*, c.teacher_id, c.id AS course_id, c.title AS course_title
      FROM materials m
      JOIN chapters ch ON ch.id = m.chapter_id
      JOIN courses  c  ON c.id  = ch.course_id
      WHERE m.id = ?
    `).get(id);
  }

  async questionContext(id) {
    return await this.db.prepare(`
      SELECT q.*, c.teacher_id, c.id AS course_id
      FROM questions q
      JOIN quizzes  z ON z.id = q.quiz_id
      JOIN chapters h ON h.id = z.chapter_id
      JOIN courses  c ON c.id = h.course_id
      WHERE q.id = ?
    `).get(id);
  }

  async answerContext(id) {
    return await this.db.prepare(`
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

  async courseLevels(courseId) {
    const rows = await this.db.prepare('SELECT level FROM course_levels WHERE course_id = ?').all(courseId);
    return rows.map((r) => r.level);
  }
}
