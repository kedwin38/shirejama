// ── Quiz attempt engine: start · autosave · submit · score (FR-5.5/5.6) ──
import { badRequest, conflict, forbidden, notFound } from '../core/errors.js';
import { nowIso, reqString } from '../core/validate.js';

const GRACE_SECONDS = 60; // network/latency tolerance on timed submits

export class AttemptService {
  constructor(db, vault) {
    this.db = db;
    this.vault = vault;
  }

  /** quiz + course chain + student-level gate (FR-6.2). */
  async _quizForStudent(quizId, student) {
    const z = await this.db.prepare(`
      SELECT z.*, c.id AS course_id, c.teacher_id, c.title AS course_title,
             h.id AS chapter_id, h.title AS chapter_title
      FROM quizzes z
      JOIN chapters h ON h.id = z.chapter_id
      JOIN courses  c ON c.id  = h.course_id
      WHERE z.id = ?
    `).get(quizId);
    if (!z) throw notFound('Quiz not found.');
    const levels = await this.vault.courseLevels(z.course_id);
    if (!levels.includes(student.academic_level)) {
      throw forbidden('This quiz belongs to a course outside your academic level.');
    }
    return z;
  }

  async _attemptOwned(attemptId, student) {
    const t = await this.db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
    if (!t) throw notFound('Attempt not found.');
    if (t.student_id !== student.id) throw forbidden('This attempt belongs to another student.');
    return t;
  }

  _deadline(t, z) {
    const parts = [];
    if (z.time_limit_min) parts.push(Date.parse(t.started_at) + z.time_limit_min * 60_000);
    if (z.closes_at) parts.push(Date.parse(z.closes_at));
    return parts.length ? Math.min(...parts) : null;
  }

  _windowState(z) {
    const now = Date.now();
    return {
      beforeOpen: z.opens_at ? now < Date.parse(z.opens_at) : false,
      afterClose: z.closes_at ? now > Date.parse(z.closes_at) : false,
    };
  }

  /** FR-5.5 — start or resume; enforces window + max attempts. */
  async start(quizId, student) {
    const z = await this._quizForStudent(quizId, student);
    const win = this._windowState(z);
    if (win.beforeOpen) throw conflict('This quiz is not open yet.');
    if (win.afterClose) throw conflict('This quiz has closed.');

    return await this.db.transaction(async () => {
      const prior = await this.db.prepare(
        'SELECT * FROM attempts WHERE quiz_id = ? AND student_id = ? ORDER BY attempt_no DESC'
      ).all(quizId, student.id);

      const running = prior.find((t) => t.status === 'in_progress');
      if (running) return await this.runningPayload(running.id, student);

      if (z.max_attempts && prior.length >= z.max_attempts) {
        throw conflict(`You have used all ${z.max_attempts} permitted attempt(s) for this quiz.`);
      }
      const { lastId } = await this.db.prepare(`
        INSERT INTO attempts (quiz_id, student_id, attempt_no, status, started_at)
        VALUES (?,?,?,'in_progress',?)
      `).run(quizId, student.id, prior.length + 1, nowIso());
      return await this.runningPayload(lastId, student);
    });
  }

  /** Running payload — never leaks correct answers or point splits of MC. */
  async runningPayload(attemptId, student) {
    const t = await this._attemptOwned(attemptId, student);
    if (t.status !== 'in_progress') throw conflict('This attempt has already been submitted.');
    const z = await this.db.prepare('SELECT * FROM quizzes WHERE id = ?').get(t.quiz_id);
    const deadline = this._deadline(t, z);

    // Timed out while away → finalize with whatever drafts are stored.
    if (deadline && Date.now() > deadline + GRACE_SECONDS * 1000) {
      return await this._finalize(t, await this._draftAnswers(t.id), { timedOut: true });
    }

    const qRows = await this.db.prepare(`
      SELECT q.id, q.type, q.prompt, q.points, q.position, q.image_path, q.attachment_path, q.attachment_name
      FROM questions q WHERE q.quiz_id = ? ORDER BY q.position, q.id
    `).all(t.quiz_id);
    const questions = [];
    for (const q of qRows) {
      questions.push({
        id: q.id, type: q.type, prompt: q.prompt, points: q.points,
        has_image: !!q.image_path, has_attachment: !!q.attachment_path,
        attachment_name: q.attachment_name,
        options: q.type === 'mc' ? await this.db.prepare(
          'SELECT id, label FROM options WHERE question_id = ? ORDER BY position, id'
        ).all(q.id) : undefined,
      });
    }

    const draftRows = await this.db.prepare(
      'SELECT * FROM answers WHERE attempt_id = ?'
    ).all(t.id);
    const drafts = draftRows.map((a) => ({
      question_id: a.question_id, option_id: a.option_id,
      text: a.text_answer, file_name: a.file_name, has_file: !!a.file_path,
    }));

    return {
      attempt: {
        id: t.id, quiz_id: t.quiz_id, attempt_no: t.attempt_no,
        started_at: t.started_at,
        deadline_at: deadline ? new Date(deadline).toISOString() : null,
      },
      quiz: {
        id: z.id, title: z.title, instructions: z.instructions,
        time_limit_min: z.time_limit_min,
      },
      questions, drafts,
    };
  }

  async _draftAnswers(attemptId) {
    const rows = await this.db.prepare('SELECT * FROM answers WHERE attempt_id = ?').all(attemptId);
    return rows.map((a) => ({ question_id: a.question_id, option_id: a.option_id, text: a.text_answer }));
  }

  async _upsertAnswer(attemptId, qid, { option_id, text }) {
    const existing = await this.db.prepare(
      'SELECT id FROM answers WHERE attempt_id = ? AND question_id = ?'
    ).get(attemptId, qid);
    if (existing) {
      await this.db.prepare('UPDATE answers SET option_id = ?, text_answer = ? WHERE id = ?')
        .run(option_id ?? null, text ?? null, existing.id);
    } else {
      await this.db.prepare(`
        INSERT INTO answers (attempt_id, question_id, option_id, text_answer)
        VALUES (?,?,?,?)
      `).run(attemptId, qid, option_id ?? null, text ?? null);
    }
  }

  /** Autosave drafts (no scoring) — reload/crash-safe quizzes. */
  async autosave(attemptId, student, body) {
    const t = await this._attemptOwned(attemptId, student);
    if (t.status !== 'in_progress') throw conflict('This attempt has already been submitted.');
    const list = Array.isArray(body?.answers) ? body.answers : [];
    const qRows = await this.db.prepare('SELECT id FROM questions WHERE quiz_id = ?').all(t.quiz_id);
    const validQ = new Set(qRows.map((r) => r.id));
    await this.db.transaction(async () => {
      for (const a of list.slice(0, 200)) {
        const qid = Number(a?.question_id);
        if (!validQ.has(qid)) continue;
        await this._upsertAnswer(t.id, qid, {
          option_id: a.option_id != null ? Number(a.option_id) : null,
          text: typeof a.text === 'string' ? a.text.slice(0, 20000) : null,
        });
      }
    });
    return { ok: true, saved_at: nowIso() };
  }

  /** FR-5.6 — upload a DOC-question answer file, attach to draft answer. */
  async uploadAnswerFile(attemptId, student, questionId, req, fileName) {
    const t = await this._attemptOwned(attemptId, student);
    if (t.status !== 'in_progress') throw conflict('This attempt has already been submitted.');
    const q = await this.db.prepare('SELECT * FROM questions WHERE id = ? AND quiz_id = ?')
      .get(questionId, t.quiz_id);
    if (!q) throw notFound('Question not found in this quiz.');
    if (q.type !== 'doc') throw badRequest('File answers are only accepted for document-response questions.');

    const rec = await this.vault.receive(req, 'answer', fileName, { category: 'answerFile' });
    const existing = await this.db.prepare(
      'SELECT * FROM answers WHERE attempt_id = ? AND question_id = ?').get(t.id, q.id);
    if (existing) {
      const oldPath = existing.file_path;
      await this.db.prepare('UPDATE answers SET file_path = ?, file_name = ? WHERE id = ?')
        .run(rec.stored_path, rec.file_name, existing.id);
      await this.vault.removeQuietly(oldPath); // replace any earlier draft upload
    } else {
      await this.db.prepare(`
        INSERT INTO answers (attempt_id, question_id, file_path, file_name)
        VALUES (?,?,?,?)
      `).run(t.id, q.id, rec.stored_path, rec.file_name);
    }
    return { ok: true, file_name: rec.file_name, size: rec.size };
  }

  /** FR-4.8/FR-5.7 — submit: score MC instantly, hold DOC for manual grading. */
  async submit(attemptId, student, body) {
    const t = await this._attemptOwned(attemptId, student);
    if (t.status !== 'in_progress') throw conflict('This attempt has already been submitted.');
    const z = await this.db.prepare('SELECT * FROM quizzes WHERE id = ?').get(t.quiz_id);

    const deadline = this._deadline(t, z);
    const timedOut = deadline && Date.now() > deadline + GRACE_SECONDS * 1000;

    // Persist final answers (drafts already stored are the fallback for
    // whatever the client doesn't resend).
    const list = Array.isArray(body?.answers) ? body.answers : [];
    const qRows = await this.db.prepare('SELECT id FROM questions WHERE quiz_id = ?').all(t.quiz_id);
    const validQ = new Set(qRows.map((r) => r.id));
    const finalAnswers = list.filter((a) => validQ.has(Number(a?.question_id)))
      .map((a) => ({
        question_id: Number(a.question_id),
        option_id: a.option_id != null ? Number(a.option_id) : null,
        text: typeof a.text === 'string' ? a.text.slice(0, 20000) : null,
      }));
    await this.db.transaction(async () => {
      for (const a of finalAnswers) await this._upsertAnswer(t.id, a.question_id, a);
    });

    return await this._finalize(t, finalAnswers, { timedOut });
  }

  async _finalize(t, answers, { timedOut = false } = {}) {
    const z = await this.db.prepare('SELECT * FROM quizzes WHERE id = ?').get(t.quiz_id);
    const questions = await this.db.prepare(
      'SELECT * FROM questions WHERE quiz_id = ? ORDER BY position, id').all(t.quiz_id);
    const byQ = new Map(answers.map((a) => [a.question_id, a]));

    return await this.db.transaction(async () => {
      let autoScore = 0, maxScore = 0, hasDoc = false;
      for (const q of questions) {
        maxScore += q.points;
        const a = byQ.get(q.id);
        if (q.type === 'mc') {
          let correct = false;
          if (a && a.option_id != null) {
            const opt = await this.db.prepare('SELECT is_correct FROM options WHERE id = ? AND question_id = ?')
              .get(a.option_id, q.id);
            correct = !!(opt && opt.is_correct);
          }
          if (correct) autoScore += q.points;
          await this.db.prepare('UPDATE answers SET is_correct = ?, score = ? WHERE attempt_id = ? AND question_id = ?')
            .run(correct ? 1 : 0, correct ? q.points : 0, t.id, q.id);
          // ensure a row exists even if unanswered
          const exists = await this.db.prepare('SELECT 1 FROM answers WHERE attempt_id = ? AND question_id = ?').get(t.id, q.id);
          if (!exists) {
            await this.db.prepare(`
              INSERT INTO answers (attempt_id, question_id, is_correct, score) VALUES (?,?,0,0)
            `).run(t.id, q.id);
          }
        } else {
          hasDoc = true;
        }
      }

      const noDocs = !hasDoc;
      const instantRelease = noDocs && !!z.show_results; // FR-5.7
      const status = instantRelease ? 'released' : 'submitted';
      const now = nowIso();
      await this.db.prepare(`
        UPDATE attempts SET status=?, submitted_at=?, auto_score=?, manual_total=?,
                            graded_at=?, released_at=?
        WHERE id=?
      `).run(status, now, autoScore, instantRelease ? 0 : null,
             instantRelease ? now : null, instantRelease ? now : null, t.id);

      return {
        attempt_id: t.id, status, timed_out: timedOut,
        score: instantRelease ? autoScore : null,
        max_score: maxScore,
        pending_manual_grading: hasDoc || !z.show_results,
      };
    });
  }

  // ── Results (FR-5.7 / FR-5.8) ───────────────────────────────────────────
  async history(student) {
    const rows = await this.db.prepare(`
      SELECT t.id, t.attempt_no, t.status, t.started_at, t.submitted_at,
             t.auto_score, t.manual_total, t.released_at,
             z.title AS quiz_title, z.id AS quiz_id,
             c.title AS course_title,
             (SELECT COALESCE(SUM(q.points),0) FROM questions q WHERE q.quiz_id = z.id) AS max_score
      FROM attempts t
      JOIN quizzes z ON z.id = t.quiz_id
      JOIN chapters h ON h.id = z.chapter_id
      JOIN courses c ON c.id = h.course_id
      WHERE t.student_id = ?
      ORDER BY t.started_at DESC
    `).all(student.id);
    return rows.map((r) => {
      const released = r.status === 'released';
      const score = released ? (r.auto_score ?? 0) + (r.manual_total ?? 0) : null;
      return { ...r, score: score == null ? null : Math.round(score * 100) / 100, released };
    });
  }

  /** Full breakdown — only once released. */
  async breakdown(attemptId, student) {
    const t = await this._attemptOwned(attemptId, student);
    if (t.status !== 'released') {
      throw forbidden('Your result for this attempt is pending review by your teacher.');
    }
    const z = await this.db.prepare('SELECT * FROM quizzes WHERE id = ?').get(t.quiz_id);
    const questions = await this.db.prepare(
      'SELECT * FROM questions WHERE quiz_id = ? ORDER BY position, id').all(t.quiz_id);
    const answers = await this.db.prepare('SELECT * FROM answers WHERE attempt_id = ?').all(t.id);
    const ansBy = new Map(answers.map((a) => [a.question_id, a]));

    const items = [];
    for (const q of questions) {
      const a = ansBy.get(q.id);
      let correctOption = null, chosenOption = null;
      if (q.type === 'mc') {
        const opts = await this.db.prepare(
          'SELECT id, label, is_correct FROM options WHERE question_id = ? ORDER BY position').all(q.id);
        correctOption = opts.find((o) => o.is_correct) ?? null;
        chosenOption = a?.option_id ? (opts.find((o) => o.id === a.option_id) ?? null) : null;
      }
      items.push({
        question_id: q.id, type: q.type, prompt: q.prompt, points: q.points,
        has_image: !!q.image_path, has_attachment: !!q.attachment_path,
        attachment_name: q.attachment_name,
        your_option: chosenOption ? { id: chosenOption.id, label: chosenOption.label } : null,
        your_text: a?.text_answer ?? null,
        your_file: a?.file_path ? { name: a.file_name, answer_id: a.id } : null,
        is_correct: q.type === 'mc' ? !!(a && a.is_correct) : null,
        correct_option: correctOption ? { id: correctOption.id, label: correctOption.label } : null,
        score: a?.score ?? null,
      });
    }

    const total = (t.auto_score ?? 0) + (t.manual_total ?? 0);
    return {
      attempt: {
        id: t.id, attempt_no: t.attempt_no, status: t.status,
        started_at: t.started_at, submitted_at: t.submitted_at, released_at: t.released_at,
        score: Math.round(total * 100) / 100,
        max_score: items.reduce((s, q) => s + q.points, 0),
      },
      quiz: { id: z.id, title: z.title },
      items,
    };
  }
}
