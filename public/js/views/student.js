// ── Student Learning Portal (FR-5.x) — consume, practice, achieve ────────
import { api } from '../lib/api.js';
import { el, icons, toast, confirmDialog, openModal, openTheater,
         fmtDate, fmtDateTime, fmtBytes, fmtScore, countdownText,
         LEVEL_LABELS, uploadWithProgress } from '../lib/ui.js';

export const STUDENT_NAV = [
  { label: 'My Learning', path: '/student', icon: 'book' },
  { label: 'My Results', path: '/student/results', icon: 'chart' },
];

export async function renderStudent(main, route) {
  const parts = route.parts;
  try {
    if (parts[1] === 'course' && parts[2]) await renderCourse(main, Number(parts[2]));
    else if (parts[1] === 'results') await renderResults(main, parts[2] ? Number(parts[2]) : null);
    else if (parts[1] === 'quiz' && parts[2]) await renderQuizRunner(main, Number(parts[2]));
    else await renderCatalog(main);
  } catch (e) {
    if (e.status === 404 || e.status === 403) {
      main.replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'e-ico' }, icons.xCircle()),
        el('h4', {}, 'Not available'), el('p', {}, e.message),
        el('a', { class: 'btn ghost', href: '#/student' }, 'Back to my learning')));
    } else throw e;
  }
}

/* ══════════ CATALOG ══════════ */
async function renderCatalog(main) {
  const { courses } = await api.get('/api/student/courses');
  main.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('div', { class: 'eyebrow' }, 'Student Learning Portal'),
        el('h1', {}, 'My Learning'),
        el('div', { class: 'head-sub' },
          `Every course for your level — ${LEVEL_LABELS[window.SJ_USER?.academic_level] || ''}. Mark chapters done as you progress.`))),
    courses.length === 0
      ? el('div', { class: 'card frame' }, el('div', { class: 'empty' },
          el('div', { class: 'e-ico' }, icons.book()),
          el('h4', {}, 'No courses for your level yet'),
          el('p', {}, 'When your teachers publish courses for your class or form, they will appear here automatically.')))
      : el('div', { class: 'course-grid' }, courses.map(courseCard)),
  );
}

function courseCard(c) {
  return el('div', { class: 'card frame course-card' },
    el('div', { class: 'cc-band' }),
    el('div', { class: 'cc-pad' },
      el('div', { class: 'row', style: 'align-items:flex-start' },
        el('div', { class: 'ring' + (c.progress_pct === 100 ? '' : ''), style: `--pct:${c.progress_pct}`, title: `${c.progress_pct}% complete` },
          el('span', { class: 'ring-num' }, `${c.progress_pct}%`)),
        el('h3', { style: 'flex:1' }, c.title)),
      el('div', { class: 'cc-desc' }, c.description || ''),
      el('div', { class: 'cc-meta' },
        (c.levels ?? []).map((l) => el('span', { class: 'chip neutral mono' }, LEVEL_LABELS[l])),
        el('span', { class: 'chip info' }, `${c.done_chapters}/${c.chapter_count} chapters done`)),
      el('div', { class: 'cc-foot' },
        el('a', { class: 'btn primary sm', href: `#/student/course/${c.id}` }, el('span', { class: 'ic' }, icons.play()), 'Continue learning'),
        el('span', { class: 'spacer' }),
        el('span', { class: 'cc-teacher' }, 'with ', el('b', {}, c.teacher_name)))));
}

/* ══════════ COURSE PAGE ══════════ */
async function renderCourse(main, courseId) {
  const data = await api.get(`/api/student/courses/${courseId}`);
  const { course, chapters, progress_pct } = data;

  const toggleDone = async (ch, done, btn) => {
    try {
      const r = await api.put(`/api/student/progress/${ch.id}`, { done });
      btn.classList.toggle('on', done);
      btn.querySelector('.dc-label').textContent = done ? 'Chapter done' : 'Mark chapter done';
      const ring = document.getElementById('course-ring');
      if (ring) { ring.style.setProperty('--pct', r.progress_pct); ring.querySelector('.ring-num').textContent = `${r.progress_pct}%`; }
      toast(done ? 'Chapter marked done — well done.' : 'Chapter reopened.', 'ok', 2500);
    } catch (e) { toast(e.message, 'err'); }
  };

  const chapterNodes = chapters.map((ch) => {
    const doneBtn = el('label', { class: 'done-check' + (ch.done ? ' on' : ''), tabindex: '0', role: 'button' },
      el('span', { class: 'dc-ring' }),
      el('span', { class: 'dc-label' }, ch.done ? 'Chapter done' : 'Mark chapter done'));
    const trigger = () => toggleDone(ch, !ch.done, doneBtn);
    doneBtn.addEventListener('click', (e) => { e.preventDefault(); trigger(); });
    doneBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger(); } });

    return el('div', { class: 'chapter' },
      el('div', { class: 'chapter-head' },
        el('div', { class: 'ch-num ring-seal' }, String(ch.position).padStart(2, '0')),
        el('div', { class: 'ch-title' }, ch.title),
        doneBtn),
      el('div', { class: 'chapter-body' },
        ch.materials.length === 0 && ch.quizzes.length === 0 && el('div', { class: 'list-note faint' }, 'Nothing published in this chapter yet.'),
        ch.materials.map((m) => materialRow(m)),
        ch.quizzes.map((z) => quizRow(z, course))));
  });

  main.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('div', { class: 'eyebrow' }, 'Course'),
        el('h1', {}, course.title),
        el('div', { class: 'head-sub' }, course.description || '')),
      el('div', { class: 'head-actions' },
        el('div', { class: 'ring lg', id: 'course-ring', style: `--pct:${progress_pct}` },
          el('span', { class: 'ring-num' }, `${progress_pct}%`)))),
    el('div', { class: 'row wrap mb-2' },
      el('span', { class: 'chip neutral' }, `with ${course.teacher_name}`),
      course.levels.map((l) => el('span', { class: 'chip gold mono' }, LEVEL_LABELS[l]))),
    ...(course.resource_url ? [el('a', {
      class: 'btn gold-ghost mb-2', href: course.resource_url, target: '_blank', rel: 'noopener',
      style: 'display:inline-flex',
    }, el('span', { class: 'ic' }, icons.grid()), 'Open the course learning material ↗')] : []),
    ...(chapters.length === 0
      ? [el('div', { class: 'card frame' }, el('div', { class: 'empty' }, el('div', { class: 'e-ico' }, icons.layers()),
          el('h4', {}, 'Chapters coming soon'), el('p', {}, 'Your teacher is still preparing this course.')))]
      : chapterNodes),
  );
}

function materialRow(m) {
  // External learning-material link (media hosted elsewhere) — opens directly.
  if (m.kind === 'link') {
    let host = m.link_url || '';
    try { host = new URL(m.link_url).hostname; } catch {}
    return el('div', { class: 'res-row' },
      el('div', { class: 'rr-ico' }, icons.grid()),
      el('div', { class: 'rr-main' },
        el('div', { class: 'rr-title' }, m.title),
        el('div', { class: 'rr-sub' },
          el('span', {}, 'External resource'),
          el('span', { class: 'mono' }, host),
          m.description && el('span', {}, m.description))),
      el('div', { class: 'rr-actions' },
        el('a', { class: 'btn sm primary', href: m.link_url, target: '_blank', rel: 'noopener' },
          el('span', { class: 'ic' }, icons.play()), 'Open ↗')));
  }

  const isVideo = m.kind === 'video';
  const posKey = `sj-video-pos-${m.id}`;
  const openIt = () => openTheater((card, close) => {
    const stage = el('div', { class: 'theater-stage' },
      isVideo
        ? (() => {
          const v = el('video', { controls: true, preload: 'metadata', src: `/api/files/material/${m.id}`, autoplay: true });
          // Resume where the learner left off — vital on intermittent links.
          let lastSave = 0;
          v.addEventListener('loadedmetadata', () => {
            const pos = Number(localStorage.getItem(posKey) || 0);
            if (pos > 8 && pos < v.duration - 5) {
              v.currentTime = pos;
              toast(`Resuming from ${Math.floor(pos / 60)}:${String(Math.floor(pos % 60)).padStart(2, '0')}`, 'info', 2500);
            }
          });
          v.addEventListener('timeupdate', () => {
            const now = Date.now();
            if (now - lastSave > 4000) {
              lastSave = now;
              try { localStorage.setItem(posKey, String(Math.floor(v.currentTime))); } catch {}
            }
          });
          v.addEventListener('ended', () => { try { localStorage.removeItem(posKey); } catch {} });
          return v;
        })()
        : el('iframe', { src: `/api/files/material/${m.id}`, title: m.title }));
    card.append(
      el('div', { class: 'theater-bar' },
        el('span', { class: 't-title' }, m.title),
        el('span', { class: 'spacer' }),
        m.allow_download && el('a', { class: 'btn sm gold-ghost', href: `/api/files/material/${m.id}?download=1` },
          el('span', { class: 'ic' }, icons.download()), 'Download'),
        el('button', { class: 'btn sm ghost', onclick: close }, el('span', { class: 'ic' }, icons.x()), 'Close')),
      stage,
    );
  });
  return el('div', { class: 'res-row' + (isVideo ? ' rr-video' : '') },
    el('div', { class: 'rr-ico' }, isVideo ? icons.video() : icons.pdf()),
    el('div', { class: 'rr-main' },
      el('div', { class: 'rr-title' }, m.title),
      el('div', { class: 'rr-sub' },
        el('span', {}, isVideo ? 'Video lecture' : 'PDF reading'),
        el('span', { class: 'mono' }, fmtBytes(m.size_bytes)),
        m.description && el('span', {}, m.description))),
    el('div', { class: 'rr-actions' },
      el('button', { class: 'btn sm primary', onclick: openIt },
        el('span', { class: 'ic' }, isVideo ? icons.play() : icons.eye()), isVideo ? 'Watch' : 'Read')));
}

function quizRow(z, course) {
  const stateMap = {
    available: ['ok', 'Available', 'Start'],
    not_open: ['neutral', 'Not open yet', null],
    closed: ['danger', 'Closed', null],
    exhausted: ['warn', 'No attempts left', null],
  };
  const [cls, label, action] = stateMap[z.state] || ['neutral', z.state, null];
  const best = z.attempts.filter((a) => a.score != null).reduce((b, a) => Math.max(b ?? 0, a.score), null);
  return el('div', { class: 'res-row' },
    el('div', { class: 'rr-ico' }, icons.quiz()),
    el('div', { class: 'rr-main' },
      el('div', { class: 'rr-title' }, z.title),
      el('div', { class: 'rr-sub' },
        el('span', {}, `${z.question_count} questions`),
        z.time_limit_min && el('span', {}, `${z.time_limit_min} min limit`),
        z.max_attempts && el('span', {}, `${z.used_attempts}/${z.max_attempts} attempts used`),
        z.opens_at && el('span', {}, `opens ${fmtDateTime(z.opens_at)}`),
        z.closes_at && el('span', {}, `closes ${fmtDateTime(z.closes_at)}`),
        best != null && el('span', { class: 'mono' }, `best ${fmtScore(best, null)}`),
        z.running_attempt_id && el('span', { class: 'chip warn' }, 'attempt in progress'))),
    el('div', { class: 'rr-actions' },
      z.state === 'available' && !z.running_attempt_id &&
        el('a', { class: 'btn sm primary', href: `#/student/quiz/${z.id}` }, el('span', { class: 'ic' }, icons.play()), 'Start'),
      z.running_attempt_id &&
        el('a', { class: 'btn sm primary', href: `#/student/quiz/${z.id}` }, el('span', { class: 'ic' }, icons.refresh()), 'Resume'),
      z.attempts.filter((a) => a.status === 'released').length > 0 &&
        el('button', { class: 'btn sm ghost', onclick: () => { location.hash = `#/student/results`; } }, 'Results')),
    el('span', { class: `chip ${cls}` }, label));
}

/* ══════════ QUIZ RUNNER (FR-5.5 / FR-5.6) ══════════ */
async function renderQuizRunner(main, quizId) {
  let data;
  try {
    data = await api.post(`/api/student/quizzes/${quizId}/start`);
  } catch (e) {
    main.replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'e-ico' }, icons.xCircle()),
      el('h4', {}, 'Cannot start'), el('p', {}, e.message),
      el('a', { class: 'btn ghost', href: '#/student' }, 'Back to my learning')));
    return;
  }

  const { attempt, quiz, questions, drafts } = data;
  const answers = new Map(); // question_id -> {option_id?, text?, file?}
  for (const d of drafts) {
    answers.set(d.question_id, { option_id: d.option_id ?? null, text: d.text ?? null, file: d.has_file ? d : null });
  }
  let current = 0;
  const draftKey = `sj-quiz-draft-${attempt.id}`;

  // restore local drafts newer than server drafts
  try {
    const local = JSON.parse(localStorage.getItem(draftKey) || 'null');
    if (local && Date.parse(local.saved) > Date.parse(attempt.started_at)) {
      for (const [qid, a] of Object.entries(local.answers || {})) {
        const cur = answers.get(Number(qid)) || {};
        answers.set(Number(qid), { ...cur, ...a, file: cur.file ?? null });
      }
    }
  } catch {}

  const timerPill = el('span', { class: 'timer-pill', role: 'timer', 'aria-live': 'off' }, icons.clock(), el('span', { class: 't-num' }, ''));
  const dots = el('div', { class: 'q-nav-dots', role: 'navigation', 'aria-label': 'Question navigator' });
  const stage = el('div');
  const autosaveNote = el('span', { class: 'autosave-note' }, 'answers autosave');

  const answeredCount = () => [...answers.values()].filter((a) => a.option_id != null || (a.text && a.text.trim()) || a.file).length;

  function drawDots() {
    dots.replaceChildren(...questions.map((q, i) => {
      const a = answers.get(q.id);
      const done = a && (a.option_id != null || (a.text && a.text.trim()) || a.file);
      return el('button', {
        class: `q-dot${i === current ? ' current' : ''}${done ? ' answered' : ''}`,
        'aria-label': `Question ${i + 1}${done ? ' (answered)' : ''}`,
        onclick: () => { current = i; draw(); },
      }, String(i + 1));
    }));
  }

  function draw() {
    const q = questions[current];
    const a = answers.get(q.id) || {};
    drawDots();
    const parts = [];

    if (q.type === 'mc') {
      parts.push(el('div', { class: 'mt-1' }, q.options.map((o, oi) => {
        const letter = 'ABCDEFGH'[oi] || '·';
        const picked = a.option_id === o.id;
        return el('label', { class: 'choice' + (picked ? ' picked' : '') },
          el('input', { type: 'radio', name: `q-${q.id}`, checked: picked, onchange: () => {
            answers.set(q.id, { ...a, option_id: o.id });
            save(); draw();
          } }),
          el('span', { class: 'letter' }, letter),
          el('span', { style: 'flex:1' }, o.label));
      })));
      if (q.has_image) {
        parts.push(el('div', { class: 'mt-1' },
          el('img', { class: 'q-img', src: `/api/files/question/${q.id}?kind=image`, alt: 'Question illustration', loading: 'lazy' })));
      }
    } else {
      if (q.has_attachment) {
        parts.push(el('a', { class: 'attachment-note', href: `/api/files/question/${q.id}?kind=attachment`, target: '_blank', rel: 'noopener' },
          el('span', { class: 'ic', style: 'color:var(--gold-600)' }, icons.file()),
          el('span', {}, 'Open the reading/worksheet: ', el('b', {}, q.attachment_name || 'attached file')),
          el('span', { class: 'ic' }, icons.eye())));
      }
      parts.push(el('div', { class: 'field' },
        el('label', {}, 'YOUR WRITTEN ANSWER'),
        el('textarea', { class: 'input', style: 'min-height:120px', placeholder: 'Type your answer here…',
          oninput: (e) => { answers.set(q.id, { ...a, text: e.target.value }); queueSave(); } }, a.text || '')));
      parts.push(el('div', { class: 'field' },
        el('label', {}, 'OR ATTACH YOUR ANSWER FILE (PDF / WORD / IMAGE)'),
        (() => {
          const fi = el('input', { type: 'file', accept: '.pdf,.doc,.docx,.png,.jpg,.jpeg,.webp', style: 'display:none' });
          const status = el('div', { class: 'hint mt-1' }, a.file ? `Attached: ${a.file.file_name || 'file'} ✓` : '');
          const upbar = el('div', { class: 'upbar', style: 'display:none' }, el('i', { style: 'width:0%' }));
          fi.addEventListener('change', async () => {
            const f = fi.files[0]; if (!f) return;
            status.textContent = `Uploading ${f.name}…`; upbar.style.display = 'block';
            try {
              const r = await uploadWithProgress({
                url: `/api/student/attempts/${attempt.id}/answer-file?question_id=${q.id}&name=${encodeURIComponent(f.name)}`,
                body: f,
                onProgress: (l, t) => { upbar.firstChild.style.width = `${Math.round((l / t) * 100)}%`; },
              });
              answers.set(q.id, { ...(answers.get(q.id) || {}), file: { file_name: r.file_name } });
              status.textContent = `Attached: ${r.file_name} ✓`; status.style.color = 'var(--ok)';
              save(); drawDots();
            } catch (e) {
              status.textContent = e.message; status.style.color = 'var(--danger)'; upbar.style.display = 'none';
            }
          });
          const wrap = el('div', {},
            el('button', { class: 'btn ghost sm', onclick: () => fi.click() }, el('span', { class: 'ic' }, icons.upload()), 'Choose answer file'),
            status, upbar, fi);
          return wrap;
        })()));
    }

    stage.replaceChildren(
      el('div', { class: 'run-q card frame' },
        el('div', { class: 'row' },
          el('span', { class: 'rq-pos' }, `Question ${current + 1} of ${questions.length}`),
          el('span', { class: 'chip neutral mono' }, `${q.points} pts`),
          el('span', { class: 'q-type-badge ' + q.type }, q.type === 'mc' ? 'MULTIPLE CHOICE' : 'DOCUMENT')),
        el('div', { class: 'rq-prompt' }, q.prompt),
        ...parts),
      el('div', { class: 'row mt-2' },
        el('button', { class: 'btn ghost', disabled: current === 0, onclick: () => { current--; draw(); window.scrollTo({ top: 0 }); } },
          el('span', { class: 'ic' }, icons.arrowLeft()), 'Previous'),
        current < questions.length - 1
          ? el('button', { class: 'btn primary', onclick: () => { current++; draw(); window.scrollTo({ top: 0 }); } }, 'Next question')
          : el('button', { class: 'btn primary', onclick: submitFlow }, el('span', { class: 'ic' }, icons.check()), 'Submit quiz'),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn danger-ghost', onclick: async () => {
          const ok = await confirmDialog({ title: 'Leave the quiz?', body: 'Your answers are saved. You can resume while the quiz window is open.', danger: true, confirmLabel: 'Leave' });
          if (ok) location.hash = '/student';
        } }, 'Leave (saved)')),
    );
  }

  async function submitFlow() {
    const unanswered = questions.length - answeredCount();
    const ok = await confirmDialog({
      title: 'Submit your quiz?',
      body: el('div', {},
        el('p', {}, `You answered ${answeredCount()} of ${questions.length} questions.`),
        unanswered > 0 && el('p', { class: 'warn' }, `${unanswered} unanswered — they will score zero.`),
        el('p', { class: 'muted' }, 'Multiple-choice parts are scored instantly; document tasks await your teacher.')),
      confirmLabel: 'Submit final answers',
    });
    if (!ok) return;
    try {
      const payload = { answers: [...answers.entries()].map(([question_id, a]) => ({
        question_id, option_id: a.option_id ?? null, text: a.text ?? null,
      })) };
      const r = await api.post(`/api/student/attempts/${attempt.id}/submit`, payload);
      localStorage.removeItem(draftKey);
      // Multiple-choice-only quizzes with instant results are scored the
      // moment they land — make that achievement felt.
      if (r.score != null && r.status === 'released') {
        toast(`Auto-graded: ${r.score} / ${r.max_score} (${Math.round((r.score / r.max_score) * 100)}%)`, 'ok', 6000);
      } else {
        toast('Submitted — multiple choice scored automatically; written parts await your teacher.', 'info', 5000);
      }
      location.hash = `/student/results/${attempt.id}`;
    } catch (e) { toast(e.message, 'err'); }
  }

  /* autosave: local immediately, server every ~8s when dirty */
  let dirty = false, saving = false;
  const queueSave = () => { dirty = true; };
  const save = () => {
    dirty = true;
    localStorage.setItem(draftKey, JSON.stringify({ saved: new Date().toISOString(), answers: Object.fromEntries([...answers.entries()]) }));
  };
  const serverSave = async () => {
    if (!dirty || saving) return;
    saving = true;
    try {
      await api.put(`/api/student/attempts/${attempt.id}/autosave`, {
        answers: [...answers.entries()].map(([question_id, a]) => ({ question_id, option_id: a.option_id ?? null, text: a.text ?? null })),
      });
      dirty = false;
      autosaveNote.replaceChildren(icons.checkCircle(), `saved ${new Date().toLocaleTimeString()}`);
    } catch {}
    saving = false;
  };
  setInterval(serverSave, 8000);

  /* timer */
  let deadline = attempt.deadline_at ? Date.parse(attempt.deadline_at) : null;
  if (deadline) {
    const tick = () => {
      const left = deadline - Date.now();
      const num = timerPill.querySelector('.t-num');
      num.textContent = countdownText(left);
      timerPill.classList.toggle('warn', left < 5 * 60_000 && left >= 60_000);
      timerPill.classList.toggle('crit', left < 60_000);
      if (left <= 0) {
        clearInterval(iv);
        toast('Time is up — submitting your answers.', 'err');
        api.post(`/api/student/attempts/${attempt.id}/submit`, {
          answers: [...answers.entries()].map(([question_id, a]) => ({ question_id, option_id: a.option_id ?? null, text: a.text ?? null })),
        }).then(() => { localStorage.removeItem(draftKey); location.hash = `/student/results/${attempt.id}`; })
          .catch(() => { location.hash = '/student'; });
      }
    };
    const iv = setInterval(tick, 1000);
    tick();
  } else {
    timerPill.style.display = 'none';
  }

  main.replaceChildren(
    el('div', { class: 'runner-shell' },
      el('div', { class: 'page-head' },
        el('div', {},
          el('div', { class: 'eyebrow' }, `Attempt #${attempt.attempt_no}`),
          el('h1', {}, quiz.title)),
        el('div', { class: 'head-actions' }, timerPill)),
      quiz.instructions && el('div', { class: 'gate-note mb-2' }, quiz.instructions),
      el('div', { class: 'runner-top' }, dots, el('span', { class: 'spacer' }), autosaveNote),
      stage),
  );
  draw();
}

/* ══════════ RESULTS (FR-5.7 / FR-5.8) ══════════ */
async function renderResults(main, attemptId) {
  if (attemptId) {
    let data;
    try { data = await api.get(`/api/student/results/${attemptId}`); }
    catch (e) {
      main.replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'e-ico' }, icons.clock()),
        el('h4', {}, 'Pending review'), el('p', {}, e.message),
        el('a', { class: 'btn ghost', href: '#/student/results' }, 'All my results')));
      return;
    }
    drawBreakdown(main, data);
    return;
  }
  const { attempts } = await api.get('/api/student/results');
  const headRow = el('tr', {}, ['Quiz', 'Course', 'Attempt', 'Submitted', 'Score', 'Status', ''].map((h) => el('th', {}, h)));
  const rows = attempts.map((a) => {
    const statusCell = a.status === 'released'
      ? el('span', { class: 'chip ok' }, 'Released')
      : a.status === 'in_progress'
        ? el('span', { class: 'chip warn' }, 'In progress')
        : el('span', { class: 'chip warn' }, 'Pending review');
    return el('tr', {},
      el('td', {}, el('b', {}, a.quiz_title)),
      el('td', { class: 'faint' }, a.course_title),
      el('td', { class: 'mono' }, `#${a.attempt_no}`),
      el('td', {}, a.submitted_at ? fmtDateTime(a.submitted_at) : '—'),
      el('td', { class: 'mono' }, a.released ? `${a.score} / ${a.max_score}` : '—'),
      el('td', {}, statusCell),
      el('td', {}, a.released && el('a', { class: 'btn sm ghost', href: `#/student/results/${a.id}` }, 'Breakdown')));
  });
  const table = el('table', { class: 'tbl' },
    el('thead', {}, headRow),
    el('tbody', {}, rows));
  main.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('div', { class: 'eyebrow' }, 'Achievement Record'),
        el('h1', {}, 'My Results'),
        el('div', { class: 'head-sub' }, 'Every attempt, its score once released, and full answer breakdowns.'))),
    attempts.length === 0
      ? el('div', { class: 'card frame' }, el('div', { class: 'empty' },
          el('div', { class: 'e-ico' }, icons.chart()),
          el('h4', {}, 'No attempts yet'), el('p', {}, 'Your quiz history will grow here as you learn.')))
      : el('div', { class: 'table-wrap' }, table),
  );
}

function drawBreakdown(main, { attempt, quiz, items }) {
  const pct = attempt.max_score ? Math.round((attempt.score / attempt.max_score) * 100) : 0;
  main.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('div', { class: 'eyebrow' }, 'Result Breakdown'),
        el('h1', {}, quiz.title),
        el('div', { class: 'head-sub' }, `Attempt #${attempt.attempt_no} · submitted ${fmtDateTime(attempt.submitted_at)} · released ${fmtDateTime(attempt.released_at)}`)),
      el('div', { class: 'head-actions' },
        el('div', { class: 'ring lg', style: `--pct:${pct}` }, el('span', { class: 'ring-num' }, `${pct}%`)),
        el('a', { class: 'btn ghost', href: '#/student/results' }, 'All results'))),
    el('div', { class: 'card frame mb-2' }, el('div', { class: 'card-pad row' },
      el('div', { style: 'flex:1' },
        el('div', { class: 's-label' }, 'FINAL SCORE'),
        el('div', { style: 'font-family:var(--font-display);font-size:30px;font-weight:600' }, `${attempt.score} / ${attempt.max_score}`)),
      el('div', { class: 'no-print' },
        el('button', { class: 'btn ghost sm', onclick: () => window.print() }, el('span', { class: 'ic' }, icons.download()), 'Print / save PDF')))),
    ...items.map((q, i) => el('div', { class: 'grade-item' },
      el('div', { class: 'gi-head' },
        el('span', { class: 'q-type-badge ' + q.type }, q.type === 'mc' ? 'MULTIPLE CHOICE' : 'DOCUMENT'),
        el('span', { class: 'chip neutral mono' }, `${q.points} pts`),
        q.type === 'mc' && (q.is_correct
          ? el('span', { class: 'verdict ok' }, icons.checkCircle(), `Correct (+${q.score})`)
          : el('span', { class: 'verdict no' }, icons.xCircle(), 'Incorrect')),
        q.type === 'doc' && el('span', { class: 'chip gold' }, `Teacher: ${q.score ?? 0} / ${q.points}`)),
      el('div', { class: 'gi-prompt' }, `${i + 1}. ${q.prompt}`),
      q.type === 'mc' && el('div', { class: 'mb-1' },
        el('div', { class: 'opt-row' + (q.your_option ? '' : ' faint') },
          el('span', { class: 'mono faint', style: 'font-size:11px' }, '▸ your answer'),
          el('span', {}, q.your_option?.label || '— not answered —')),
        q.correct_option && el('div', { class: 'opt-row correct' },
          el('span', { class: 'mono faint', style: 'font-size:11px' }, '✓ correct answer'),
          el('span', {}, q.correct_option.label))),
      q.your_text && el('div', { class: 'gi-answer' }, q.your_text),
      q.your_file && el('a', { class: 'btn sm ghost mt-1', href: `/api/files/answer/${q.your_file.answer_id}`, target: '_blank', rel: 'noopener' },
        el('span', { class: 'ic' }, icons.file()), q.your_file.name),
      q.has_attachment && el('a', { class: 'btn sm ghost mt-1', href: `/api/files/question/${q.question_id}?kind=attachment`, target: '_blank', rel: 'noopener' },
        el('span', { class: 'ic' }, icons.file()), 'Question worksheet'))),
  );
}
