// ── Teacher Portal (FR-4.x) — authoring, publishing, grading ─────────────
import { api } from '../lib/api.js';
import { el, icons, toast, confirmDialog, openModal,
         fmtDate, fmtDateTime, fmtBytes, LEVEL_LABELS,
         uploadWithProgress, downloadCsv } from '../lib/ui.js';

export const TEACHER_NAV = [
  { label: 'My Courses', path: '/teacher', icon: 'book' },
  { label: 'Submissions', path: '/teacher/submissions', icon: 'inbox' },
];
const LEVELS = ['C1','C2','C3','C4','C5','C6','C7','C8','F1','F2','F3','F4'];

export async function renderTeacher(main, route) {
  const parts = route.parts;
  try {
    if (parts[0] === 'teacher' && parts[1] === 'courses' && parts[2]) await renderStudio(main, Number(parts[2]));
    else if (parts[1] === 'submissions') await renderSubmissions(main, route);
    else await renderCourseList(main);
  } catch (e) {
    if (e.status === 404 || e.status === 403) {
      main.replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'e-ico' }, icons.xCircle()),
        el('h4', {}, 'Not available'), el('p', {}, e.message),
        el('a', { class: 'btn ghost', href: '#/teacher' }, 'Back to my courses')));
    } else throw e;
  }
}

/* ══════════ COURSE LIST ══════════ */
async function renderCourseList(main) {
  const { courses } = await api.get('/api/teacher/courses');
  main.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('div', { class: 'eyebrow' }, 'Teacher Portal'),
        el('h1', {}, 'My Courses'),
        el('div', { class: 'head-sub' }, 'You author, own, and control exactly these courses.')),
      el('div', { class: 'head-actions' },
        el('button', { class: 'btn primary', onclick: () => createCourse(main) },
          el('span', { class: 'ic' }, icons.plus()), 'New course'))),
    courses.length === 0
      ? el('div', { class: 'card frame' }, el('div', { class: 'empty' },
          el('div', { class: 'e-ico' }, icons.book()),
          el('h4', {}, 'Your shelf is empty'),
          el('p', {}, 'Create your first course — title it, describe it, and tag the academic levels it serves.'),
          el('button', { class: 'btn primary', onclick: () => createCourse(main) }, el('span', { class: 'ic' }, icons.plus()), 'Create a course')))
      : el('div', { class: 'course-grid' }, courses.map((c) =>
          el('div', { class: 'card frame course-card' },
            el('div', { class: 'cc-band' }),
            el('div', { class: 'cc-pad' },
              el('h3', {}, c.title),
              el('div', { class: 'cc-desc' }, c.description || 'No description yet.'),
              el('div', { class: 'cc-meta' },
                c.levels.map((l) => el('span', { class: 'chip neutral mono' }, LEVEL_LABELS[l])),
                el('span', { class: 'chip info' }, `${c.chapter_count} chapters`),
                el('span', { class: 'chip info' }, `${c.material_count} materials`),
                el('span', { class: 'chip info' }, `${c.quiz_count} quizzes`),
                c.pending_grading > 0 && el('span', { class: 'chip warn' }, `${c.pending_grading} awaiting grading`)),
              el('div', { class: 'cc-foot' },
                el('a', { class: 'btn primary sm', href: `#/teacher/courses/${c.id}` }, el('span', { class: 'ic' }, icons.edit()), 'Open studio'),
                el('span', { class: 'spacer' }),
                el('span', { class: 'cc-teacher' }, 'updated ', fmtDate(c.updated_at))))))),
  );
}

function levelPickerV2(selected = []) {
  const wrap = el('div', { class: 'row wrap', style: 'gap:2px 18px' },
    LEVELS.map((l) => el('label', { class: 'check' },
      el('input', { type: 'checkbox', 'data-level': l, checked: selected.includes(l) }),
      el('span', {}, LEVEL_LABELS[l]))));
  return { node: wrap, value: () => [...wrap.querySelectorAll('input:checked')].map((i) => i.dataset.level) };
}

function createCourse(main) {
  openModal((card, done) => {
    const title = el('input', { class: 'input', placeholder: 'e.g. English Foundations: Reading & Writing', 'data-autofocus': true });
    const desc = el('textarea', { class: 'input', placeholder: 'What will learners gain from this course?' });
    const levels = levelPickerV2();
    const err = el('div', { class: 'err-line' });
    card.append(
      el('div', { class: 'modal-head' }, el('h3', {}, 'New Course'),
        el('button', { class: 'icon-btn x', onclick: done }, icons.x())),
      el('div', { class: 'modal-body' },
        el('div', { class: 'field' }, el('label', {}, 'TITLE ', el('span', { class: 'req' }, '*')), title),
        el('div', { class: 'field' }, el('label', {}, 'DESCRIPTION'), desc),
        el('div', { class: 'field' }, el('label', {}, 'ACADEMIC LEVELS ', el('span', { class: 'req' }, '*')), levels.node,
          el('div', { class: 'hint' }, 'Only students at these levels will see the course.')),
        err),
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn ghost', onclick: done }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: async () => {
          err.textContent = '';
          try {
            const { course } = await api.post('/api/teacher/courses', { title: title.value, description: desc.value, levels: levels.value() });
            toast('Course created.', 'ok'); done();
            location.hash = `#/teacher/courses/${course.id}`;
          } catch (e) { err.textContent = e.message; }
        } }, el('span', { class: 'ic' }, icons.plus()), 'Create course')),
    );
  });
}

/* ══════════ COURSE STUDIO ══════════ */
async function renderStudio(main, courseId) {
  const { course } = await api.get(`/api/teacher/courses/${courseId}`);
  const chaptersHtml = course.chapters.map((h) => chapterBlock(course, h));
  main.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('div', { class: 'eyebrow' }, 'Course Studio'),
        el('h1', {}, course.title),
        el('div', { class: 'head-sub' }, course.description || '')),
      el('div', { class: 'head-actions' },
        el('button', { class: 'btn', onclick: () => courseAnalytics(course) },
          el('span', { class: 'ic' }, icons.chart()), 'Course analytics'),
        el('button', { class: 'btn ghost', onclick: () => editCourse(course) }, el('span', { class: 'ic' }, icons.edit()), 'Edit details'),
        el('button', { class: 'btn danger-ghost', onclick: () => deleteCourse(course) }, el('span', { class: 'ic' }, icons.trash()), 'Delete course'))),
    el('div', { class: 'row wrap mb-2' },
      course.levels.map((l) => el('span', { class: 'chip gold mono' }, LEVEL_LABELS[l])),
      el('span', { class: 'chip neutral' }, `${course.chapters.length} chapters`)),
    el('div', { id: 'chapter-list' }, chaptersHtml),
    el('div', { class: 'mt-2' },
      el('button', { class: 'btn', onclick: () => addChapter(course) }, el('span', { class: 'ic' }, icons.plus()), 'Add chapter')),
  );
}

function chapterBlock(course, h) {
  const body = el('div', { class: 'chapter-body' });
  const draw = () => {
    body.replaceChildren(
      el('div', { class: 'list-note' }, 'MATERIALS'),
      h.materials.length === 0 && el('div', { class: 'list-note faint' }, 'No materials yet.'),
      ...h.materials.map((m) => el('div', { class: 'res-row' + (m.kind === 'video' ? ' rr-video' : '') },
        el('div', { class: 'rr-ico' }, m.kind === 'video' ? icons.video() : icons.pdf()),
        el('div', { class: 'rr-main' },
          el('div', { class: 'rr-title' }, m.title),
          el('div', { class: 'rr-sub' },
            el('span', { class: 'mono' }, m.file_name), el('span', {}, fmtBytes(m.size_bytes)),
            el('span', {}, m.allow_download ? '· downloadable' : '· stream only'))),
        el('div', { class: 'rr-actions' },
          el('span', { class: 'chip ' + (m.allow_download ? 'ok' : 'neutral') }, m.allow_download ? 'download allowed' : 'view only'),
          el('button', { class: 'icon-btn', title: 'Delete material', style: 'color:var(--danger)', onclick: async () => {
            const ok = await confirmDialog({ title: 'Delete material?', body: `“${m.title}” and its stored file will be removed.`, danger: true, confirmLabel: 'Delete' });
            if (!ok) return;
            await api.delete(`/api/teacher/materials/${m.id}`); toast('Material deleted.', 'ok');
            document.dispatchEvent(new CustomEvent('reload-view'));
          } }, icons.trash())))),
      el('div', { class: 'row mt-1 mb-2' },
        el('button', { class: 'btn ghost sm', onclick: () => uploadMaterial(course, h) }, el('span', { class: 'ic' }, icons.upload()), 'Upload PDF / video')),
      el('div', { class: 'list-note' }, 'QUIZZES'),
      h.quizzes.length === 0 && el('div', { class: 'list-note faint' }, 'No quizzes yet.'),
      ...h.quizzes.map((z) => quizBlock(course, h, z)),
      el('div', { class: 'row mt-1' },
        el('button', { class: 'btn ghost sm', onclick: () => quizDialog(course, h, null) }, el('span', { class: 'ic' }, icons.quiz()), 'Create quiz')),
    );
  };
  draw();

  return el('div', { class: 'chapter' },
    el('div', { class: 'chapter-head' },
      el('div', { class: 'ch-num ring-seal' }, String(h.position).padStart(2, '0')),
      el('div', { class: 'ch-title' }, h.title),
      el('div', { class: 'ch-tools' },
        el('button', { class: 'icon-btn', title: 'Move up', onclick: () => moveChapter(course, h, 'up') }, icons.arrowUp()),
        el('button', { class: 'icon-btn', title: 'Move down', onclick: () => moveChapter(course, h, 'down') }, icons.arrowDown()),
        el('button', { class: 'icon-btn', title: 'Rename chapter', onclick: () => renameChapter(course, h) }, icons.edit()),
        el('button', { class: 'icon-btn', title: 'Delete chapter', style: 'color:var(--danger)', onclick: () => deleteChapter(course, h) }, icons.trash()))),
    body);
}

function quizBlock(course, h, z) {
  return el('div', { class: 'card q-card' },
    el('div', { class: 'q-head' },
      el('span', { class: 'ic', style: 'color:var(--gold-600)' }, icons.quiz()),
      el('b', {}, z.title),
      z.has_document_questions && el('span', { class: 'chip warn' }, 'manual grading'),
      z.show_results && !z.has_document_questions && el('span', { class: 'chip ok' }, 'instant results'),
      z.time_limit_min && el('span', { class: 'chip neutral' }, `${z.time_limit_min} min`),
      z.max_attempts && el('span', { class: 'chip neutral' }, `max ${z.max_attempts}`),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn sm ghost', onclick: () => quizDialog(course, h, z) }, 'Settings'),
      el('button', { class: 'btn sm ghost', style: 'color:var(--danger)', onclick: async () => {
        const ok = await confirmDialog({ title: 'Delete quiz?', danger: true, confirmLabel: 'Delete',
          body: `“${z.title}”, its ${z.question_count} question(s), and all recorded attempts & grades will be permanently removed.` });
        if (!ok) return;
        await api.delete(`/api/teacher/quizzes/${z.id}`); toast('Quiz deleted.', 'ok');
        document.dispatchEvent(new CustomEvent('reload-view'));
      } }, 'Delete'),
    ),
    el('div', { class: 'faint', style: 'font-size:12px' },
      `${z.question_count} questions · `,
      z.opens_at ? `opens ${fmtDateTime(z.opens_at)} ` : 'always open · ',
      z.closes_at ? `closes ${fmtDateTime(z.closes_at)}` : 'no close',
      z.instructions && el('span', { class: 'muted' }, ` · “${z.instructions.slice(0, 80)}${z.instructions.length > 80 ? '…' : ''}”`)),
    z.questions.length > 0 && el('div', { class: 'mt-2' }, z.questions.map((q) => el('div', { class: 'opt-row' + (q.type === 'mc' ? '' : ''), style: 'align-items:flex-start' },
      el('span', { class: 'q-type-badge ' + q.type }, q.type === 'mc' ? 'MULTIPLE CHOICE' : 'DOCUMENT'),
      el('div', { style: 'flex:1' },
        el('div', { style: 'font-size:13px' }, q.prompt.length > 120 ? q.prompt.slice(0, 120) + '…' : q.prompt),
        el('div', { class: 'faint', style: 'font-size:11px' },
          `${q.points} pts`,
          q.has_image && ' · has image',
          q.has_attachment && ` · attachment: ${q.attachment_name || 'file'}`,
          q.type === 'mc' && ` · ${q.options.length} options`)),
      el('button', { class: 'icon-btn', title: 'Delete question', style: 'color:var(--danger)', onclick: async () => {
        const ok = await confirmDialog({ title: 'Delete question?', danger: true, confirmLabel: 'Delete', body: 'This question and its options will be removed.' });
        if (!ok) return;
        await api.delete(`/api/teacher/questions/${q.id}`); toast('Question deleted.', 'ok');
        document.dispatchEvent(new CustomEvent('reload-view'));
      } }, icons.trash())))),
    el('div', { class: 'mt-1' },
      el('button', { class: 'btn ghost sm', onclick: () => questionDialog(course, z) }, el('span', { class: 'ic' }, icons.plus()), 'Add question')));
}

async function moveChapter(course, h, dir) {
  await api.post(`/api/teacher/chapters/${h.id}/move`, { dir });
  document.dispatchEvent(new CustomEvent('reload-view'));
}

function addChapter(course) {
  openModal((card, done) => {
    const title = el('input', { class: 'input', placeholder: 'e.g. Chapter 3 · Tenses and Time', 'data-autofocus': true });
    const err = el('div', { class: 'err-line' });
    card.append(
      el('div', { class: 'modal-head' }, el('h3', {}, 'Add Chapter'), el('button', { class: 'icon-btn x', onclick: done }, icons.x())),
      el('div', { class: 'modal-body' }, el('div', { class: 'field' }, el('label', {}, 'CHAPTER TITLE ', el('span', { class: 'req' }, '*')), title), err),
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn ghost', onclick: done }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: async () => {
          try { await api.post(`/api/teacher/courses/${course.id}/chapters`, { title: title.value }); toast('Chapter added.', 'ok'); done(); document.dispatchEvent(new CustomEvent('reload-view')); }
          catch (e) { err.textContent = e.message; }
        } }, el('span', { class: 'ic' }, icons.plus()), 'Add chapter')),
    );
  });
}

function renameChapter(course, h) {
  openModal((card, done) => {
    const title = el('input', { class: 'input', value: h.title, 'data-autofocus': true });
    card.append(
      el('div', { class: 'modal-head' }, el('h3', {}, 'Rename Chapter'), el('button', { class: 'icon-btn x', onclick: done }, icons.x())),
      el('div', { class: 'modal-body' }, el('div', { class: 'field' }, el('label', {}, 'CHAPTER TITLE'), title)),
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn ghost', onclick: done }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: async () => {
          await api.patch(`/api/teacher/chapters/${h.id}`, { title: title.value }); toast('Chapter renamed.', 'ok'); done();
          document.dispatchEvent(new CustomEvent('reload-view'));
        } }, 'Save')),
    );
  });
}

async function deleteChapter(course, h) {
  const ok = await confirmDialog({ title: 'Delete chapter?', danger: true, confirmLabel: 'Delete chapter',
    body: `“${h.title}” — its materials, quizzes, questions and recorded grades will be permanently removed.` });
  if (!ok) return;
  await api.delete(`/api/teacher/chapters/${h.id}`); toast('Chapter deleted.', 'ok');
  document.dispatchEvent(new CustomEvent('reload-view'));
}

function editCourse(course) {
  openModal((card, done) => {
    const title = el('input', { class: 'input', value: course.title });
    const desc = el('textarea', { class: 'input' }, course.description || '');
    desc.value = course.description || '';
    const levels = levelPickerV2(course.levels);
    const err = el('div', { class: 'err-line' });
    card.append(
      el('div', { class: 'modal-head' }, el('h3', {}, 'Edit Course'), el('button', { class: 'icon-btn x', onclick: done }, icons.x())),
      el('div', { class: 'modal-body' },
        el('div', { class: 'field' }, el('label', {}, 'TITLE'), title),
        el('div', { class: 'field' }, el('label', {}, 'DESCRIPTION'), desc),
        el('div', { class: 'field' }, el('label', {}, 'ACADEMIC LEVELS'), levels.node), err),
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn ghost', onclick: done }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: async () => {
          try {
            await api.patch(`/api/teacher/courses/${course.id}`, { title: title.value, description: desc.value, levels: levels.value() });
            toast('Course updated.', 'ok'); done(); document.dispatchEvent(new CustomEvent('reload-view'));
          } catch (e) { err.textContent = e.message; }
        } }, 'Save changes')),
    );
  });
}

async function deleteCourse(course) {
  const ok = await confirmDialog({ title: `Delete “${course.title}” entirely?`, danger: true, confirmLabel: 'Delete course forever',
    body: el('div', {},
      el('p', {}, 'This permanently removes ', el('b', {}, 'all chapters, materials, quizzes and recorded student grades'),
        ' for this course, along with every stored file. This is a real server deletion — there is no undo.') ) });
  if (!ok) return;
  await api.delete(`/api/teacher/courses/${course.id}`);
  toast('Course deleted.', 'ok');
  location.hash = '#/teacher';
}

/* ── Course analytics · cohort engagement modal ────────────────────────── */
async function courseAnalytics(course) {
  let data;
  try { data = await api.get(`/api/teacher/courses/${course.id}/analytics`); }
  catch (e) { toast(e.message, 'err'); return; }
  const { summary, chapters, quizzes, students, course: c } = data;

  const bar = (pct, label) => {
    const head = el('div', { class: 'row', style: 'font-size:12.5px;margin-bottom:3px' },
      el('span', { style: 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, label),
      el('span', { class: 'mono faint', style: 'font-size:11px' }, pct == null ? '—' : pct + '%'));
    const track = el('div', { class: 'progressbar' },
      el('i', { style: 'width:' + Math.max(0, Math.min(100, pct ?? 0)) + '%' }));
    return el('div', { style: 'margin-bottom:10px' }, head, track);
  };
  const statTile = (label, value, foot) =>
    el('div', { class: 'card stat' },
      el('div', { class: 's-label' }, label),
      el('div', { class: 's-value' }, String(value)),
      el('div', { class: 's-foot' }, foot));

  // quiz outcomes table
  const quizRows = quizzes.map((z) => el('tr', {},
    el('td', {}, el('b', { style: 'font-weight:600' }, z.title)),
    el('td', { class: 'mono' }, String(z.question_count)),
    el('td', { class: 'mono' }, z.students + '/' + summary.cohort_size),
    el('td', { class: 'mono' }, String(z.attempts)),
    el('td', { class: 'mono' }, z.avg_pct == null ? '—' : z.avg_pct + '%'),
    el('td', {}, z.pending > 0
      ? el('span', { class: 'chip warn' }, z.pending + ' to grade')
      : el('span', { class: 'chip ok' }, 'clear'))));
  const quizTable = el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {},
      ['Quiz', 'Questions', 'Students attempted', 'Attempts', 'Avg score', 'Status']
        .map((h) => el('th', {}, h)))),
    el('tbody', {}, quizRows));

  // per-student table
  const studentRows = students.map((s) => el('tr', {},
    el('td', {}, el('b', {}, s.full_name),
      el('div', { class: 'faint mono', style: 'font-size:11px' }, s.student_id || ''),
      !s.is_active ? el('span', { class: 'chip danger' }, 'inactive') : null),
    el('td', { class: 'mono' }, s.chapters_done + '/' + summary.chapters),
    el('td', {}, el('div', { class: 'progressbar', style: 'width:90px' },
      el('i', { style: 'width:' + Math.max(0, Math.min(100, s.completion_pct)) + '%' }))),
    el('td', { class: 'mono' }, String(s.attempts)),
    el('td', { class: 'mono' }, s.avg_score_pct == null ? '—' : s.avg_score_pct + '%'),
    el('td', { class: 'faint', style: 'font-size:11.5px' },
      s.last_activity ? fmtDateTime(s.last_activity) : '—')));
  const studentTable = el('table', { class: 'tbl' },
    el('thead', {}, el('tr', {},
      ['Student', 'Chapters done', 'Completion', 'Attempts', 'Avg score', 'Last activity']
        .map((h) => el('th', {}, h)))),
    el('tbody', {}, studentRows));

  const bodyChildren = [
    el('div', { class: 'stat-grid mb-2' },
      statTile('COHORT', summary.cohort_size,
        'students at ' + (c.levels.map((l) => LEVEL_LABELS[l]).join(', ') || '—')),
      statTile('AVG COMPLETION', summary.avg_completion_pct + '%',
        summary.fully_completed_students + ' finished all ' + summary.chapters + ' chapters'),
      statTile('CONTENT', summary.materials, 'materials · ' + summary.quizzes + ' quizzes')),
  ];
  if (chapters.length > 0) {
    bodyChildren.push(el('div', { class: 'mb-2' },
      el('h3', { style: 'font-size:14px;margin-bottom:10px' }, 'Chapter completion'),
      ...chapters.map((h) => bar(h.done_pct, h.students_done + '/' + summary.cohort_size + ' done — ' + h.title))));
  }
  if (quizzes.length > 0) {
    bodyChildren.push(el('div', { class: 'mb-2' },
      el('h3', { style: 'font-size:14px;margin-bottom:10px' }, 'Quiz outcomes'),
      el('div', { class: 'table-wrap' }, quizTable)));
  }
  if (students.length > 0) {
    bodyChildren.push(el('div', {},
      el('h3', { style: 'font-size:14px;margin-bottom:10px' }, 'Students'),
      el('div', { class: 'table-wrap' }, studentTable)));
  }

  openModal((card, done) => {
    card.append(
      el('div', { class: 'modal-head' },
        el('span', { class: 'ic', style: 'color:var(--gold-600)' }, icons.chart()),
        el('h3', {}, 'Course Analytics'),
        el('span', { class: 'chip neutral' }, c.title),
        el('button', { class: 'icon-btn x', 'aria-label': 'Close', onclick: done }, icons.x())),
      el('div', { class: 'modal-body' }, ...bodyChildren),
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn ghost', onclick: () => {
          downloadCsv(`cohort-${c.id}.csv`,
            ['Student', 'Student ID', 'Level', 'Chapters done', 'Completion %', 'Attempts', 'Avg score %', 'Last activity'],
            students.map((s) => [s.full_name, s.student_id, s.academic_level,
              `${s.chapters_done}/${summary.chapters}`, s.completion_pct,
              s.attempts, s.avg_score_pct ?? '', s.last_activity ?? '']));
          toast('Cohort CSV exported.', 'ok', 2500);
        } }, el('span', { class: 'ic' }, icons.download()), 'Export students'),
        el('button', { class: 'btn primary', 'data-autofocus': true, onclick: done }, 'Close')),
    );
  }, { wide: true });
}

/* ── Material upload (streamed raw PUT with progress) ──────────────────── */
function uploadMaterial(course, h) {
  openModal((card, done) => {
    let file = null;
    const title = el('input', { class: 'input', placeholder: 'Material title' });
    const desc = el('input', { class: 'input', placeholder: 'Optional description' });
    const allow = el('input', { type: 'checkbox' });
    const fileInput = el('input', { type: 'file', accept: '.pdf,video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov,.m4v', style: 'display:none' });
    const drop = el('div', { class: 'dropzone', tabindex: '0', role: 'button', onclick: () => fileInput.click(),
      onkeydown: (e) => { if (e.key === 'Enter') fileInput.click(); } },
      icons.upload(), el('div', {}, el('b', {}, 'Choose a PDF or video'), el('div', { class: 'hint' }, 'PDF up to 100 MB · MP4/WebM/MOV up to 2 GB')));
    const bar = el('div', { class: 'upbar', style: 'display:none' }, el('i', { style: 'width:0%' }));
    const pct = el('div', { class: 'hint mono' });
    const err = el('div', { class: 'err-line' });
    const kindOf = (f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf' ? 'pdf' : 'video';

    fileInput.addEventListener('change', () => {
      file = fileInput.files[0];
      if (file) {
        drop.replaceChildren(icons[kindOf(file) === 'pdf' ? 'pdf' : 'video'](),
          el('div', {}, el('b', {}, file.name), el('div', { class: 'hint' }, `${fmtBytes(file.size)} · will be uploaded as ${kindOf(file).toUpperCase()}`)));
        if (!title.value) title.value = file.name.replace(/\.[a-z0-9]+$/i, '');
      }
    });
    ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => {
      file = e.dataTransfer.files[0];
      if (file) fileInput.dispatchEvent(new Event('change'));
    });

    card.append(
      el('div', { class: 'modal-head' }, el('h3', {}, 'Upload Material'), el('button', { class: 'icon-btn x', onclick: done }, icons.x())),
      el('div', { class: 'modal-body' },
        drop, fileInput,
        el('div', { class: 'field mt-2' }, el('label', {}, 'TITLE ', el('span', { class: 'req' }, '*')), title),
        el('div', { class: 'field' }, el('label', {}, 'DESCRIPTION'), desc),
        el('label', { class: 'check' }, allow, el('span', {}, el('b', {}, 'Allow download'), el('div', { class: 'hint' }, 'Otherwise students can only view/stream in the browser.'))),
        bar, pct, err),
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn ghost', onclick: done }, 'Cancel'),
        el('button', { class: 'btn primary', 'data-autofocus': true, onclick: async (e) => {
          err.textContent = '';
          if (!file) { err.textContent = 'Choose a file first.'; return; }
          if (!title.value.trim()) { err.textContent = 'Give the material a title.'; return; }
          const btn = e.currentTarget; btn.disabled = true;
          bar.style.display = 'block';
          try {
            await uploadWithProgress({
              method: 'PUT',
              url: `/api/teacher/chapters/${h.id}/materials?title=${encodeURIComponent(title.value.trim())}`
                + `&description=${encodeURIComponent(desc.value.trim())}`
                + `&kind=${kindOf(file)}&allow_download=${allow.checked ? '1' : '0'}`
                + `&name=${encodeURIComponent(file.name)}`,
              body: file,
              onProgress: (loaded, total) => {
                bar.firstChild.style.width = `${Math.round((loaded / total) * 100)}%`;
                pct.textContent = `${fmtBytes(loaded)} / ${fmtBytes(total)}`;
              },
            });
            toast('Material uploaded.', 'ok'); done();
            document.dispatchEvent(new CustomEvent('reload-view'));
          } catch (ue) {
            err.textContent = ue.message; btn.disabled = false; bar.style.display = 'none';
          }
        } }, el('span', { class: 'ic' }, icons.upload()), 'Upload')),
    );
  });
}

/* ── Quiz settings dialog ──────────────────────────────────────────────── */
function quizDialog(course, h, existing) {
  openModal((card, done) => {
    const title = el('input', { class: 'input', value: existing?.title || '', placeholder: 'Quiz title' });
    const instructions = el('textarea', { class: 'input', placeholder: 'Shown to students before they begin (optional)' });
    instructions.value = existing?.instructions || '';
    const timeLimit = el('input', { class: 'input mono', type: 'number', min: '1', max: '600', placeholder: 'none', value: existing?.time_limit_min || '' });
    const maxAttempts = el('input', { class: 'input mono', type: 'number', min: '1', max: '100', placeholder: 'unlimited', value: existing?.max_attempts || '' });
    const opens = el('input', { class: 'input', type: 'datetime-local', value: existing?.opens_at ? toLocalInput(existing.opens_at) : '' });
    const closes = el('input', { class: 'input', type: 'datetime-local', value: existing?.closes_at ? toLocalInput(existing.closes_at) : '' });
    const showResults = el('input', { type: 'checkbox', checked: existing ? !!existing.show_results : true });
    const err = el('div', { class: 'err-line' });
    card.append(
      el('div', { class: 'modal-head' }, el('h3', {}, existing ? 'Quiz Settings' : 'Create Quiz'), el('button', { class: 'icon-btn x', onclick: done }, icons.x())),
      el('div', { class: 'modal-body' },
        el('div', { class: 'field' }, el('label', {}, 'TITLE ', el('span', { class: 'req' }, '*')), title),
        el('div', { class: 'field' }, el('label', {}, 'INSTRUCTIONS'), instructions),
        el('div', { class: 'form-grid' },
          el('div', { class: 'field' }, el('label', {}, 'TIMER (MINUTES)'), timeLimit, el('div', { class: 'hint' }, 'Blank = untimed')),
          el('div', { class: 'field' }, el('label', {}, 'MAX ATTEMPTS'), maxAttempts, el('div', { class: 'hint' }, 'Blank = unlimited'))),
        el('div', { class: 'form-grid' },
          el('div', { class: 'field' }, el('label', {}, 'OPENS AT (YOUR TIME)'), opens),
          el('div', { class: 'field' }, el('label', {}, 'CLOSES AT (YOUR TIME)'), closes)),
        el('label', { class: 'check' }, showResults, el('span', {}, el('b', {}, 'Show auto-graded results immediately'),
          el('div', { class: 'hint' }, 'Quizzes with document questions are always held for your review first.'))),
        err),
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn ghost', onclick: done }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: async () => {
          err.textContent = '';
          const body = {
            title: title.value, instructions: instructions.value,
            time_limit_min: timeLimit.value ? Number(timeLimit.value) : null,
            max_attempts: maxAttempts.value ? Number(maxAttempts.value) : null,
            opens_at: opens.value || null, closes_at: closes.value || null,
            show_results: showResults.checked,
          };
          try {
            if (existing) await api.patch(`/api/teacher/quizzes/${existing.id}`, body);
            else await api.post(`/api/teacher/chapters/${h.id}/quizzes`, body);
            toast(existing ? 'Quiz updated.' : 'Quiz created.', 'ok');
            done(); document.dispatchEvent(new CustomEvent('reload-view'));
          } catch (e2) { err.textContent = e2.message; }
        } }, existing ? 'Save settings' : 'Create quiz')),
    );
  });
}
const toLocalInput = (iso) => {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/* ── Question builder ──────────────────────────────────────────────────── */
function questionDialog(course, quiz) {
  openModal((card, done) => {
    let type = 'mc';
    const prompt = el('textarea', { class: 'input', placeholder: 'The question prompt…', style: 'min-height:90px' });
    const points = el('input', { class: 'input mono', type: 'number', min: '1', max: '100', value: '1' });

    // MC option editor
    const opts = el('div');
    const optRow = (label = '', correct = false) => {
      const radio = el('input', { type: 'radio', name: 'qz-correct', checked: correct, title: 'Mark this option as the correct answer' });
      const inp = el('input', { class: 'input', placeholder: 'Answer option', value: label });
      const row = el('div', { class: 'opt-row' + (correct ? ' correct' : '') },
        radio, inp,
        el('button', { class: 'icon-btn', title: 'Remove option', onclick: () => { if (opts.children.length > 2) row.remove(); else toast('A multiple-choice question needs at least two options.', 'err'); } }, icons.x()));
      radio.addEventListener('change', () => [...opts.children].forEach((r) => r.classList.toggle('correct', r.querySelector('input[type=radio]').checked)));
      return row;
    };
    const resetOpts = () => opts.replaceChildren(optRow('', true), optRow());
    resetOpts();

    // attachments
    let imageToken = null, attachToken = null, attachName = null;
    const imgStatus = el('div', { class: 'hint mt-1' });
    const imgInput = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', style: 'display:none' });
    const attachInput = el('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg,.webp,.gif', style: 'display:none' });
    imgInput.addEventListener('change', async () => {
      const f = imgInput.files[0]; if (!f) return;
      imgStatus.textContent = `Uploading ${f.name}…`;
      try {
        const r = await uploadWithProgress({ url: `/api/teacher/files/question?kind=image&name=${encodeURIComponent(f.name)}`, body: f });
        imageToken = r.token; imgStatus.textContent = `Image attached: ${r.file_name} ✓`; imgStatus.style.color = 'var(--ok)';
      } catch (e) { imgStatus.textContent = e.message; imgStatus.style.color = 'var(--danger)'; }
    });
    attachInput.addEventListener('change', async () => {
      const f = attachInput.files[0]; if (!f) return;
      const st = attachStatus; st.textContent = `Uploading ${f.name}…`;
      try {
        const r = await uploadWithProgress({ url: `/api/teacher/files/question?kind=attachment&name=${encodeURIComponent(f.name)}`, body: f });
        attachToken = r.token; attachName = r.file_name; st.textContent = `Attached: ${r.file_name} ✓`; st.style.color = 'var(--ok)';
      } catch (e) { st.textContent = e.message; st.style.color = 'var(--danger)'; }
    });
    const attachStatus = el('div', { class: 'hint mt-1' });

    const mcExtras = el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'ANSWER OPTIONS — TICK THE CORRECT ONE'),
        opts,
        el('button', { class: 'btn ghost sm mt-1', onclick: () => opts.append(optRow()) }, el('span', { class: 'ic' }, icons.plus()), 'Add option')),
      el('div', { class: 'field' }, el('label', {}, 'OPTIONAL QUESTION IMAGE (DIAGRAM, PHOTO…)'),
        el('button', { class: 'btn ghost sm', onclick: () => imgInput.click() }, el('span', { class: 'ic' }, icons.upload()), 'Attach image'),
        imgInput, imgStatus));
    const docExtras = el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'DOCUMENT THE STUDENT MUST READ (OPTIONAL)'),
        el('button', { class: 'btn ghost sm', onclick: () => attachInput.click() }, el('span', { class: 'ic' }, icons.upload()), 'Attach PDF / image worksheet'),
        attachInput, attachStatus),
      el('div', { class: 'gate-note' }, 'Students answer by typing, uploading their own PDF/Word/image file, or both. Always graded by you manually.'));

    const typeToggle = el('div', { class: 'seg' },
      el('button', { class: 'on', onclick: (e) => { type = 'mc'; segPick(e); extras.replaceChildren(mcExtras); } }, 'Multiple choice · auto-graded'),
      el('button', { onclick: (e) => { type = 'doc'; segPick(e); extras.replaceChildren(docExtras); } }, 'Document · manual grading'));
    const segPick = (e) => { [...e.currentTarget.parentNode.children].forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); };
    const extras = el('div', {}, mcExtras);
    const err = el('div', { class: 'err-line' });

    card.append(
      el('div', { class: 'modal-head' }, el('h3', {}, 'Add Question'), el('button', { class: 'icon-btn x', onclick: done }, icons.x())),
      el('div', { class: 'modal-body' },
        typeToggle,
        el('div', { class: 'field mt-2' }, el('label', {}, 'PROMPT ', el('span', { class: 'req' }, '*')), prompt),
        el('div', { class: 'field', style: 'max-width:130px' }, el('label', {}, 'POINTS'), points),
        extras, err),
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn ghost', onclick: done }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: async () => {
          err.textContent = '';
          const body = { type, prompt: prompt.value, points: Number(points.value) || 1 };
          if (type === 'mc') {
            body.options = [...opts.children].map((r) => ({
              label: r.querySelector('input.input').value,
              is_correct: r.querySelector('input[type=radio]').checked,
            }));
            if (imageToken) body.image_token = imageToken;
          } else if (attachToken) {
            body.attachment_token = attachToken; body.attachment_name = attachName;
          }
          try {
            await api.post(`/api/teacher/quizzes/${quiz.id}/questions`, body);
            toast('Question added.', 'ok'); done();
            document.dispatchEvent(new CustomEvent('reload-view'));
          } catch (e2) { err.textContent = e2.message; }
        } }, el('span', { class: 'ic' }, icons.plus()), 'Add question')),
    );
  }, { wide: true });
}

/* ══════════ SUBMISSIONS & GRADING (FR-4.9 / FR-4.10) ══════════ */
async function renderSubmissions(main) {
  let status = '';
  let lastRows = [];
  const wrap = el('div');

  const load = async () => {
    wrap.replaceChildren(...Array.from({ length: 5 }, () => el('div', { class: 'skel mt-1', style: 'height:42px' })));
    const { submissions } = await api.get(`/api/teacher/submissions${status ? `?status=${status}` : ''}`);
    lastRows = submissions;
    draw(submissions);
  };
  const draw = (rows) => {
    wrap.replaceChildren(rows.length === 0
      ? el('div', { class: 'card frame' }, el('div', { class: 'empty' },
          el('div', { class: 'e-ico' }, icons.inbox()),
          el('h4', {}, 'No submissions here'), el('p', {}, 'When your students submit quizzes, attempts appear in this overview.')))
      : el('div', { class: 'table-wrap' }, el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {}, ['Student', 'Quiz · Course', 'Attempt', 'Submitted', 'Score', 'Status', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, rows.map((s) => el('tr', {},
          el('td', {}, el('b', {}, s.student_name), el('div', { class: 'faint mono', style: 'font-size:11px' }, s.student_code || '')),
          el('td', {}, el('b', { style: 'font-weight:600' }, s.quiz_title), el('div', { class: 'faint', style: 'font-size:11.5px' }, s.course_title)),
          el('td', { class: 'mono' }, `#${s.attempt_no}`),
          el('td', {}, s.submitted_at ? fmtDateTime(s.submitted_at) : '—'),
          el('td', { class: 'mono' }, s.score != null ? `${s.score} / ${s.max_score}` : '—'),
          statusChip(s),
          el('td', {}, el('button', { class: 'btn sm ghost', onclick: () => gradingDrawer(s) }, 'Review answers')),
        ))))));
  };
  const statusChip = (s) => {
    const m = {
      in_progress: ['warn', 'In progress'],
      submitted: ['warn', s.unscored_doc_answers > 0 ? `Awaiting grading (${s.unscored_doc_answers} doc)` : 'Awaiting release'],
      graded: ['info', 'Graded — unreleased'],
      released: ['ok', 'Released'],
    }[s.status] || ['neutral', s.status];
    return el('td', {}, el('span', { class: `chip ${m[0]}` }, m[1]));
  };

  main.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('div', { class: 'eyebrow' }, 'Assessment'),
        el('h1', {}, 'Student Submissions'),
        el('div', { class: 'head-sub' }, 'Every attempt from your courses — review answers, score document tasks, release results.')),
      el('div', { class: 'head-actions' },
        el('button', { class: 'btn ghost', onclick: () => {
          downloadCsv('submissions.csv',
            ['Student', 'Student ID', 'Quiz', 'Course', 'Attempt', 'Status', 'Submitted', 'Score', 'Max'],
            lastRows.map((s) => [s.student_name, s.student_code, s.quiz_title, s.course_title,
              `#${s.attempt_no}`, s.status, s.submitted_at ?? '', s.score ?? '', s.max_score]));
          toast('submissions.csv exported.', 'ok', 2500);
        } }, el('span', { class: 'ic' }, icons.download()), 'Export CSV'))),
    el('div', { class: 'tabs' },
      [['', 'All'], ['submitted', 'Needs attention'], ['graded', 'Graded, unreleased'], ['released', 'Released'], ['in_progress', 'Live']].map(([v, l]) =>
        el('button', { class: 'tab' + (status === v ? ' active' : ''), onclick: (e) => {
          status = v; [...e.currentTarget.parentNode.children].forEach((b) => b.classList.remove('active'));
          e.currentTarget.classList.add('active'); load();
        } }, l))),
    wrap,
  );
  await load();
}

async function gradingDrawer(s) {
  const data = await api.get(`/api/teacher/attempts/${s.id}`);
  const { attempt, quiz, course, student, items } = data;
  openModal((card, done) => {
    const scores = new Map(); // answer_id -> input
    const err = el('div', { class: 'err-line' });

    const itemNodes = items.map((q, idx) => {
      const scoreInput = q.answer_id != null ? el('input', {
        class: 'input score-input', type: 'number', min: '0', max: q.points, step: '0.5',
        value: q.score != null ? q.score : '', placeholder: `/ ${q.points}`,
      }) : null;
      if (scoreInput) scores.set(q.answer_id, scoreInput);

      return el('div', { class: 'grade-item' },
        el('div', { class: 'gi-head' },
          el('span', { class: 'q-type-badge ' + q.type }, q.type === 'mc' ? 'MULTIPLE CHOICE' : 'DOCUMENT'),
          el('span', { class: 'chip neutral mono' }, `${q.points} pts`),
          q.type === 'mc' && (q.answered_correctly
            ? el('span', { class: 'verdict ok' }, icons.checkCircle(), 'Correct')
            : el('span', { class: 'verdict no' }, icons.xCircle(), 'Incorrect / unanswered')),
          el('span', { class: 'spacer' }),
          q.answer_file && el('a', { class: 'btn sm ghost', href: `/api/files/answer/${q.answer_file.answer_id}`, target: '_blank', rel: 'noopener' },
            el('span', { class: 'ic' }, icons.file()), q.answer_file.name),
          q.has_attachment && el('a', { class: 'btn sm ghost', href: `/api/files/question/${q.question_id}?kind=attachment`, target: '_blank', rel: 'noopener' },
            el('span', { class: 'ic' }, icons.file()), 'Question file'),
          q.has_image && el('a', { class: 'btn sm ghost', href: `/api/files/question/${q.question_id}?kind=image`, target: '_blank', rel: 'noopener' },
            el('span', { class: 'ic' }, icons.eye()), 'Question image')),
        el('div', { class: 'gi-prompt' }, `${idx + 1}. ${q.prompt}`),
        q.type === 'mc' && q.options && el('div', { class: 'mb-2' }, q.options.map((o) =>
          el('div', { class: 'opt-row' + (o.is_correct ? ' correct' : '') + (o.id === q.chosen_option_id ? '' : '') ,
            style: (o.id === q.chosen_option_id ? 'border-left:3px solid var(--gold-600);' : '') + (o.is_correct ? '' : '') },
            el('span', { class: 'mono faint', style: 'font-size:11px' }, o.id === q.chosen_option_id ? '▸ student' : o.is_correct ? '✓ correct' : ''),
            el('span', {}, o.label),
            o.is_correct && el('span', { class: 'chip ok', style: 'margin-left:auto' }, 'answer')))),
        q.text_answer && el('div', { class: 'gi-answer' }, q.text_answer),
        !q.text_answer && !q.answer_file && q.type === 'doc' && el('div', { class: 'gi-answer faint' }, 'No typed answer provided.'),
        q.type === 'doc' && scoreInput && el('div', { class: 'gi-controls' },
          el('span', { class: 'hint' }, 'Your score:'), scoreInput, el('span', { class: 'hint' }, `/ ${q.points} pts`)),
        q.type === 'mc' && scoreInput && el('div', { class: 'gi-controls' },
          el('span', { class: 'hint' }, 'Override (optional):'), scoreInput, el('span', { class: 'hint' }, `/ ${q.points} pts`)));
    });

    const total = (attempt.auto_score ?? 0) + (attempt.manual_total ?? 0);
    card.append(
      el('div', { class: 'modal-head' },
        el('h3', {}, 'Review Answers'),
        el('button', { class: 'icon-btn x', onclick: done }, icons.x())),
      el('div', { class: 'modal-body' },
        el('div', { class: 'row wrap mb-2' },
          el('span', { class: 'chip neutral' }, student.full_name),
          student.student_id && el('span', { class: 'chip gold mono' }, student.student_id),
          el('span', { class: 'chip neutral' }, quiz.title),
          el('span', { class: 'chip neutral' }, `attempt #${attempt.attempt_no}`),
          statusBadge(attempt.status)),
        el('div', { class: 'faint mb-2', style: 'font-size:12px' },
          `Started ${fmtDateTime(attempt.started_at)} · Submitted ${attempt.submitted_at ? fmtDateTime(attempt.submitted_at) : '—'}`,
          attempt.status !== 'in_progress' && ` · Auto ${attempt.auto_score ?? 0} + Manual ${attempt.manual_total ?? 0} = ${total} / ${attempt.max_score}`),
        ...itemNodes, err),
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn ghost', onclick: done }, 'Close'),
        attempt.status !== 'released' && attempt.status !== 'in_progress' && el('button', { class: 'btn', onclick: async (e) => {
          err.textContent = '';
          const payload = [...scores.entries()].filter(([, inp]) => inp.value !== '')
            .map(([answer_id, inp]) => ({ answer_id, score: Number(inp.value) }));
          if (!payload.length) { err.textContent = 'Enter at least one score (or use Release if nothing needs manual scoring).'; return; }
          e.currentTarget.disabled = true;
          try {
            await api.post(`/api/teacher/attempts/${attempt.id}/score`, { scores: payload });
            toast('Scores saved.', 'ok'); done();
            document.dispatchEvent(new CustomEvent('reload-view'));
          } catch (e2) { err.textContent = e2.message; e.currentTarget.disabled = false; }
        } }, el('span', { class: 'ic' }, icons.check()), 'Save scores'),
        (attempt.status === 'graded' || attempt.status === 'submitted') && el('button', { class: 'btn primary', onclick: async (e) => {
          err.textContent = ''; e.currentTarget.disabled = true;
          try {
            await api.post(`/api/teacher/attempts/${attempt.id}/release`);
            toast('Result released to the student.', 'ok'); done();
            document.dispatchEvent(new CustomEvent('reload-view'));
          } catch (e2) { err.textContent = e2.message; e.currentTarget.disabled = false; }
        } }, el('span', { class: 'ic' }, icons.award()), 'Release result')),
    );
  }, { wide: true });
}

const statusBadge = (s) => ({
  in_progress: el('span', { class: 'chip warn' }, 'In progress'),
  submitted: el('span', { class: 'chip warn' }, 'Awaiting grading / release'),
  graded: el('span', { class: 'chip info' }, 'Graded — unreleased'),
  released: el('span', { class: 'chip ok' }, 'Released'),
}[s] || el('span', { class: 'chip neutral' }, s));
