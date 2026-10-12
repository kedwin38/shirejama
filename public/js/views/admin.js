// ── Administrator portal (FR-3.x, FR-7) ───────────────────────────────────
import { api } from '../lib/api.js';
import { el, icons, toast, confirmDialog, openModal, closeModal,
         fmtDate, fmtBytes, fmtDateTime, LEVEL_LABELS, passwordProblems, downloadCsv } from '../lib/ui.js';
import { parseStudentsFile } from '../lib/student-import.js';

export const ADMIN_NAV = [
  { label: 'Overview', path: '/admin', icon: 'grid' },
  { label: 'Accounts', path: '/admin/accounts', icon: 'users' },
  { label: 'Provision Access', path: '/admin/provision', icon: 'userPlus' },
  { label: 'Analytics', path: '/admin/analytics', icon: 'chart' },
  { label: 'Backup Console', path: '/admin/backups', icon: 'database' },
];

const LEVELS = ['C1','C2','C3','C4','C5','C6','C7','C8','F1','F2','F3','F4'];

export async function renderAdmin(main, route) {
  const tab = route.parts[1] || '';
  try {
    if (tab === 'accounts') await renderAccounts(main);
    else if (tab === 'provision') renderProvision(main);
    else if (tab === 'analytics') await renderAnalytics(main);
    else if (tab === 'backups') await renderBackups(main);
    else await renderOverview(main);
  } catch (e) {
    main.replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'e-ico' }, icons.xCircle()),
      el('h4', {}, 'Could not load'), el('p', {}, e.message)));
  }
}

/* ── Overview ──────────────────────────────────────────────────────────── */
async function renderOverview(main) {
  const stats = await api.get('/api/admin/stats');
  main.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('div', { class: 'eyebrow' }, 'Institution Control Center'),
        el('h1', {}, 'Overview'),
        el('div', { class: 'head-sub' }, 'A live picture of the institution: people, content, and academic activity.')),
    ),
    el('div', { class: 'stat-grid' },
      stat('Teachers', stats.teachers, `${stats.courses} courses authored`, 'users'),
      stat('Students', stats.students, `${LEVEL_LABELS.C1}–${LEVEL_LABELS.F4} cohorts`, 'award'),
      stat('Courses Live', stats.courses, `${stats.materials} materials · ${stats.quizzes} quizzes`, 'book'),
      stat('Awaiting Grading', stats.pendingGrading, 'submissions pending review', 'inbox'),
      stat('Active Accounts', stats.activeAccounts, `${stats.inactiveAccounts} deactivated`, 'shield'),
      stat('Backups Taken', stats.backups, 'configurable in Backup Console', 'database'),
    ),
    el('div', { class: 'card frame mt-3' }, el('div', { class: 'card-pad' },
      el('h3', {}, 'Institution rules'),
        el('div', { class: 'list-note' },
          '• Students never self-register — every account is provisioned from ', el('b', {}, 'Provision Access'), '.'),
        el('div', { class: 'list-note' }, '• Teachers who still own courses cannot be deleted — deactivate or reassign first.'),
        el('div', { class: 'list-note' }, '• All uploaded files are served through permission-checked endpoints, never public URLs.'),
        el('div', { class: 'list-note' }, '• Backups go to the cloud storage you connect in ', el('b', {}, 'Backup Console'), '.'),
      )),
  );
}
const stat = (label, value, foot, ico) =>
  el('div', { class: 'card stat', style: 'position:relative' },
    el('div', { class: 's-ico' }, icons[ico]()),
    el('div', { class: 's-label' }, label), el('div', { class: 's-value' }, String(value)),
    el('div', { class: 's-foot' }, foot));

/* ── Accounts ──────────────────────────────────────────────────────────── */
async function renderAccounts(main) {
  let role = 'teacher', q = '';
  let lastUsers = [];
  const tblWrap = el('div');

  async function load() {
    tblWrap.replaceChildren(...Array.from({ length: 6 }, () => el('div', { class: 'skel mt-1', style: 'height:38px' })));
    const { users } = await api.get(`/api/admin/users?role=${role}&q=${encodeURIComponent(q)}`);
    lastUsers = users;
    drawTable(users);
  }

  function drawTable(users) {
    const head = { teacher: ['Instructor', 'Code', 'Email', 'Courses', 'Status', ''], student: ['Student', 'ID', 'Username', 'Level', 'Status', ''], admin: ['Administrator', 'Username', 'Email', '', 'Status', ''] }[role];
    tblWrap.replaceChildren(
      users.length === 0 ? el('div', { class: 'empty' }, el('div', { class: 'e-ico' }, icons.search()),
        el('h4', {}, 'No accounts found'), el('p', {}, 'Try a different search or role tab.')) :
      el('div', { class: 'table-wrap' }, el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))),
        el('tbody', {}, users.map((u) => el('tr', {},
          el('td', {}, el('b', {}, u.full_name), el('div', { class: 'faint mono', style: 'font-size:11px' }, u.username)),
          role === 'admin' ? el('td', { class: 'mono' }, u.username)
            : el('td', {}, el('span', { class: 'chip gold mono' }, role === 'teacher' ? (u.instructor_code || '—') : (u.student_id || '—'))),
          el('td', {}, u.email || '—'),
          role === 'teacher' ? el('td', {}, String(u.course_count)) :
            role === 'student' ? el('td', {}, LEVEL_LABELS[u.academic_level] || '—') : el('td', {}, ''),
          statusChip(u),
          el('td', {}, el('div', { class: 'row-actions' },
            el('button', { class: 'btn sm ghost', title: 'Edit account details', onclick: () => editUser(u) }, 'Edit'),
            el('button', { class: 'btn sm ghost', title: 'Reset this user\u2019s password', onclick: () => resetPassword(u) }, 'Reset password'),
            el('button', { class: 'icon-btn', title: u.is_active ? 'Deactivate account' : 'Activate account', onclick: () => toggleActive(u) },
              u.is_active ? icons.xCircle() : icons.checkCircle()),
            role !== 'admin' && el('button', { class: 'icon-btn', title: 'Delete permanently', onclick: () => deleteUser(u), style: 'color:var(--danger)' }, icons.trash()),
          )),
        ))),
      )));
  }

  const search = el('input', { class: 'input', placeholder: 'Search name, username, email, code…', oninput: (e) => { q = e.target.value; clearTimeout(search._t); search._t = setTimeout(load, 250); } });

  main.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('div', { class: 'eyebrow' }, 'People of the Institution'),
        el('h1', {}, 'Accounts'),
        el('div', { class: 'head-sub' }, 'Provision, inspect, correct, activate, and — when truly necessary — delete.')),
      el('div', { class: 'head-actions' }, el('a', { class: 'btn primary', href: '#/admin/provision' }, el('span', { class: 'ic' }, icons.userPlus()), 'Provision new account')),
    ),
    el('div', { class: 'tabs', role: 'tablist' },
      ['teacher', 'student', 'admin'].map((r) => el('button', {
        class: 'tab' + (role === r ? ' active' : ''), role: 'tab', 'aria-selected': role === r ? 'true' : 'false',
        onclick: (e) => { role = r; [...e.currentTarget.parentNode.children].forEach((b) => b.classList.remove('active')); e.currentTarget.classList.add('active'); load(); },
      }, { teacher: 'Teachers', student: 'Students', admin: 'Administrators' }[r]))),
    el('div', { class: 'row mb-2' },
      search,
      el('button', { class: 'btn ghost sm', title: 'Export the current list as a spreadsheet', onclick: () => {
        downloadCsv(`accounts-${role}.csv`,
          ['Name', 'Username', 'Email', role === 'teacher' ? 'Instructor code' : 'Student ID', 'Level', 'Courses', 'Status', 'Created'],
          lastUsers.map((u) => [u.full_name, u.username, u.email ?? '',
            role === 'teacher' ? (u.instructor_code ?? '') : (u.student_id ?? ''),
            u.academic_level ?? '', u.course_count ?? '', u.is_active ? 'active' : 'inactive', u.created_at]));
        toast(`accounts-${role}.csv exported.`, 'ok', 2500);
      } }, el('span', { class: 'ic' }, icons.download()), 'Export CSV'),
      el('span', { class: 'spacer' })),
    tblWrap,
  );
  await load();
}

const statusChip = (u) => el('td', {}, u.is_active
  ? el('span', { class: 'chip ok' }, icons.checkCircle(), 'Active')
  : el('span', { class: 'chip danger' }, icons.xCircle(), 'Inactive'));

async function toggleActive(u) {
  try {
    await api.patch(`/api/admin/users/${u.id}`, { is_active: !u.is_active });
    toast(`${u.full_name} ${u.is_active ? 'deactivated' : 're-activated'}.`, 'ok');
    document.querySelector('.main').dispatchEvent(new CustomEvent('reload-view'));
  } catch (e) { toast(e.message, 'err'); }
}

function editUser(u) {
  openModal((card, done) => {
    const name = el('input', { class: 'input', value: u.full_name });
    const username = el('input', { class: 'input', value: u.username });
    const email = el('input', { class: 'input', value: u.email || '', placeholder: u.role === 'student' ? 'Students have no email' : 'name@shirejama.school' });
    const err = el('div', { class: 'err-line' });
    const roleField = u.role === 'teacher'
      ? el('div', { class: 'field' }, el('label', {}, 'INSTRUCTOR CODE'), code = el('input', { class: 'input mono', value: u.instructor_code || '' }))
      : u.role === 'student'
        ? el('div', { class: 'field' }, el('label', {}, 'STUDENT ID'), sid = el('input', { class: 'input mono', value: u.student_id || '' }))
        : null;
    let code, sid;
    const levelSel = u.role === 'student' ? el('select', { class: 'select' },
      LEVELS.map((l) => el('option', { value: l, selected: u.academic_level === l }, LEVEL_LABELS[l]))) : null;
    card.append(
      el('div', { class: 'modal-head' }, el('h3', {}, `Edit · ${u.role}`),
        el('button', { class: 'icon-btn x', onclick: done }, icons.x())),
      el('div', { class: 'modal-body' },
        el('div', { class: 'field' }, el('label', {}, 'FULL NAME'), name),
        el('div', { class: 'field' }, el('label', {}, 'USERNAME'), username),
        u.role !== 'student' && el('div', { class: 'field' }, el('label', {}, 'EMAIL'), email),
        roleField,
        levelSel && el('div', { class: 'field' }, el('label', {}, 'ACADEMIC LEVEL'), levelSel),
        err,
      ),
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn ghost', onclick: done }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: async () => {
          err.textContent = '';
          const patch = { full_name: name.value, username: username.value };
          if (u.role !== 'student') patch.email = email.value;
          else patch.email = ''; // clear/keep students email-free
          if (u.role === 'teacher' && code?.value) patch.instructor_code = code.value;
          if (u.role === 'student') {
            if (sid?.value) patch.student_id = sid.value;
            if (levelSel.value) patch.academic_level = levelSel.value;
          }
          try { await api.patch(`/api/admin/users/${u.id}`, patch); toast('Account updated.', 'ok'); done(); }
          catch (e) { err.textContent = e.message; }
        } }, 'Save changes')),
    );
  });
}

function resetPassword(u) {
  openModal((card, done) => {
    const pw = el('input', { class: 'input mono', type: 'text', placeholder: 'Temporary password', 'data-autofocus': true });
    const err = el('div', { class: 'err-line' });
    const hint = el('div', { class: 'hint mt-1' });
    pw.addEventListener('input', () => {
      const p = passwordProblems(pw.value);
      hint.textContent = p.length ? `Password needs ${p.join(', ')}.` : 'Meets the password policy ✓';
      hint.style.color = p.length ? 'var(--danger)' : 'var(--ok)';
    });
    card.append(
      el('div', { class: 'modal-head' }, el('h3', {}, 'Reset Password'),
        el('button', { class: 'icon-btn x', onclick: done }, icons.x())),
      el('div', { class: 'modal-body' },
        el('p', { class: 'mt-0 muted' }, 'Set a new password for ', el('b', {}, u.full_name), '. Their live sessions will be revoked.'),
        el('div', { class: 'field' }, el('label', {}, 'NEW TEMPORARY PASSWORD'), pw, hint),
        el('div', { class: 'row' },
          el('button', { class: 'btn ghost sm', onclick: () => { pw.value = 'Shire@' + new Date().getFullYear(); pw.dispatchEvent(new Event('input')); } }, 'Use standard temporary')),
        err),
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn ghost', onclick: done }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: async () => {
          err.textContent = '';
          try { await api.post(`/api/admin/users/${u.id}/reset-password`, { password: pw.value }); toast(`Password reset for ${u.full_name}.`, 'ok'); done(); }
          catch (e) { err.textContent = e.details?.length ? `${e.message} Needs ${e.details.join(', ')}.` : e.message; }
        } }, el('span', { class: 'ic' }, icons.key()), 'Reset password')),
    );
  });
}

async function deleteUser(u) {
  const ok = await confirmDialog({
    title: `Delete ${u.role} permanently?`,
    body: el('div', {},
      el('p', {}, 'You are about to permanently delete ', el('b', {}, u.full_name), ' (', el('span', { class: 'mono' }, u.username), ').'),
      u.role === 'student' && el('p', { class: 'warn' }, 'Their quiz attempts, answers, and progress history will be removed with the account.'),
      el('p', { class: 'muted' }, 'Deactivation is reversible; deletion is not.')),
    danger: true, confirmLabel: 'Delete forever',
  });
  if (!ok) return;
  try {
    await api.delete(`/api/admin/users/${u.id}`);
    toast(`${u.full_name} deleted.`, 'ok');
    document.querySelector('.main').dispatchEvent(new CustomEvent('reload-view'));
  } catch (e) { toast(e.message, 'err', 7000); }
}

/* ── Provision (FR-3.1 / FR-3.2) ───────────────────────────────────────── */
function renderProvision(main) {
  main.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('div', { class: 'eyebrow' }, 'Create Institutional Access'),
        el('h1', {}, 'Provision Accounts'),
        el('div', { class: 'head-sub' }, 'New accounts sign in immediately — students sign in with their Student ID and password.'))),
    el('div', { class: 'grid-2' }, teacherForm(), studentForm()),
    el('div', { class: 'mt-2' }, bulkStudentForm()),
  );
}

/* ── Bulk provision: CSV/XLSX (Name, Student_ID) for one academic level ── */
function bulkStudentForm() {
  const BATCH = 100;
  let parsed = null; // { rows, invalid }

  const level = el('select', { class: 'select' },
    el('option', { value: '' }, 'Academic level for this file…'),
    LEVELS.map((l) => el('option', { value: l }, LEVEL_LABELS[l])));
  let pwOk = false;
  const pw = pwField((ok) => { pwOk = ok; updateBtn(); });

  const fileInput = el('input', { type: 'file', accept: '.csv,.xlsx,.xls,text/csv', style: 'display:none' });
  const drop = el('div', { class: 'dropzone', tabindex: '0', role: 'button',
    onclick: () => fileInput.click(),
    onkeydown: (e) => { if (e.key === 'Enter') fileInput.click(); } },
    icons.upload(),
    el('div', {}, el('b', {}, 'Upload student list — CSV or XLSX'),
      el('div', { class: 'hint' }, 'Two columns: Name, Student_ID. Students who already have accounts are skipped and reported.')));
  const templateBtn = el('button', { class: 'btn ghost sm', title: 'Download a ready-to-fill CSV template',
    onclick: () => {
      downloadCsv('student-list-template.csv',
        ['Name', 'Student_ID'],
        [
          ['Amina Yusuf', 'ADM-2026-0601'],
          ['Botan Ahmed', 'ADM-2026-0602'],
        ]);
      toast('Template downloaded — replace the example rows with your students.', 'info', 4500);
    } }, el('span', { class: 'ic' }, icons.download()), 'CSV template');
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); });

  const preview = el('div');
  const err = el('div', { class: 'err-line' });
  const createBtn = el('button', { class: 'btn primary mt-1', disabled: true, onclick: runProvision },
    el('span', { class: 'ic' }, icons.userPlus()), 'Create accounts');

  async function readFile(file) {
    err.textContent = ''; parsed = null; updateBtn();
    preview.replaceChildren(
      el('div', { class: 'upbar', style: 'display:block;margin:10px 0 6px' },
        el('i', { style: 'width:40%;transition:width .4s ease' })),
      el('div', { class: 'hint' }, 'Reading ', el('b', {}, file.name), ' — one moment…'));
    try {
      const isX = /\.xlsx$/i.test(file.name);
      const result = isX
        ? await parseStudentsFile({ name: file.name, buffer: await file.arrayBuffer() })
        : await parseStudentsFile({ name: file.name, text: await file.text() });
      parsed = result;
      drawPreview();
    } catch (e) {
      err.textContent = e.message || 'Could not read the file.';
      preview.replaceChildren();
    }
  }

  function drawPreview() {
    const { rows, invalid } = parsed;
    const shown = rows.slice(0, 6);
    preview.replaceChildren(
      el('div', { class: 'chip ok mt-1' }, icons.checkCircle(),
        ` ${rows.length} student${rows.length === 1 ? '' : 's'} ready`),
      invalid.length > 0 && el('div', { class: 'chip warn' }, `${invalid.length} row(s) will be skipped (invalid)`),
      el('div', { class: 'table-wrap mt-1', style: 'box-shadow:none;max-height:220px;overflow:auto' },
        el('table', { class: 'tbl' },
          el('thead', {}, el('tr', {}, ['Name', 'Student ID'].map((h) => el('th', {}, h)))),
          el('tbody', {}, [
            ...shown.map((r) => el('tr', {},
              el('td', {}, r.name), el('td', { class: 'mono' }, r.student_id))),
            rows.length > shown.length && el('tr', {}, el('td', { class: 'faint', colspan: '2' },
              `… ${rows.length - shown.length} more`)),
            ...invalid.slice(0, 3).map((r) => el('tr', { style: 'opacity:.6' },
              el('td', {}, r.name || '—'), el('td', { class: 'mono' }, r.student_id || '—'),
              el('td', { class: 'faint' }, r.reason))),
          ].filter(Boolean)))),
      invalid.length > 0 && el('div', { class: 'hint' },
        invalid.slice(0, 4).map((r) => `Row ${r.row}: ${r.reason}`).join(' · ')));
    updateBtn();
  }

  function updateBtn() {
    const ready = parsed && parsed.rows.length > 0 && pwOk && level.value;
    createBtn.disabled = !ready;
    createBtn.replaceChildren(el('span', { class: 'ic' }, icons.userPlus()),
      ready ? `Create ${parsed.rows.length} student accounts` : 'Create accounts');
  }
  level.addEventListener('change', updateBtn);

  async function runProvision() {
    err.textContent = '';
    const total = parsed.rows.length;
    const batches = Math.ceil(total / BATCH);
    const started = performance.now();
    createBtn.disabled = true;
    createBtn.textContent = 'Creating…';

    // ── live progress panel — the admin always sees what the system is doing ──
    const barFill = el('i', { style: 'width:0%;transition:width .35s ease' });
    const bar = el('div', { class: 'upbar', style: 'display:block;margin:10px 0 8px' }, barFill);
    const statusLine = el('div', { style: 'font-size:13.5px;font-weight:600' }, 'Starting…');
    const counters = el('div', { class: 'row wrap', style: 'gap:6px' });
    const progress = el('div', { style: 'padding:12px 16px;border:1px solid var(--line,#e5e7eb);border-radius:10px;margin-top:10px' },
      statusLine, bar, counters);
    preview.replaceChildren(progress);

    const all = { created: [], skipped: [], invalid: [...(parsed.invalid ?? [])] };
    const drawCounters = () => counters.replaceChildren(
      el('span', { class: 'chip ok' }, icons.checkCircle(), ` ${all.created.length} created`),
      all.skipped.length > 0 && el('span', { class: 'chip warn' }, `${all.skipped.length} skipped — already have accounts`),
      all.invalid.length > 0 && el('span', { class: 'chip danger' }, `${all.invalid.length} invalid rows`));
    const elapsed = () => `${((performance.now() - started) / 1000).toFixed(1)}s`;

    try {
      for (let b = 0; b < batches; b++) {
        const from = b * BATCH + 1;
        const to = Math.min((b + 1) * BATCH, total);
        statusLine.replaceChildren(
          `Creating accounts — batch ${b + 1} of ${batches} (rows ${from}–${to} of ${total}) · ${elapsed()} elapsed…`);
        const batch = parsed.rows.slice(b * BATCH, (b + 1) * BATCH);
        const r = await api.post('/api/admin/students/bulk', {
          academic_level: level.value, password: pw.querySelector('input').value, rows: batch });
        all.created.push(...r.created); all.skipped.push(...r.skipped); all.invalid.push(...r.invalid);
        barFill.style.width = `${Math.round(to / total * 100)}%`;
        drawCounters();
      }

      // ── finished — clear completion state + full results ──
      const { created, skipped, invalid } = all;
      barFill.style.width = '100%';
      barFill.style.background = 'var(--ok)';
      statusLine.replaceChildren(icons.checkCircle(),
        ` Done in ${elapsed()} — ${created.length} of ${total} account${created.length === 1 ? '' : 's'} created${skipped.length ? `, ${skipped.length} already existed (skipped)` : ''}.`);
      preview.replaceChildren(
        progress,
        el('div', { class: 'row wrap mt-1' },
          el('span', { class: 'chip ok' }, icons.checkCircle(), ` ${created.length} created`),
          skipped.length > 0 && el('span', { class: 'chip warn' }, `${skipped.length} already have accounts — skipped`),
          invalid.length > 0 && el('span', { class: 'chip danger' }, `${invalid.length} invalid rows`)),
        created.length > 0 && el('div', { class: 'table-wrap mt-1', style: 'box-shadow:none;max-height:260px;overflow:auto' },
          el('table', { class: 'tbl' },
            el('thead', {}, el('tr', {}, ['Student', 'Student ID (sign-in)', 'Username'].map((h) => el('th', {}, h)))),
            el('tbody', {}, created.slice(0, 50).map((u) => el('tr', {},
              el('td', {}, u.name),
              el('td', { class: 'mono' }, u.student_id),
              el('td', { class: 'mono faint' }, u.username)))))),
        skipped.length > 0 && el('div', { class: 'hint mt-1' },
          'Already have accounts: ' + skipped.slice(0, 6).map((s) => `${s.student_id} (${s.name})`).join(' · ')
          + (skipped.length > 6 ? ` … +${skipped.length - 6} more` : '')),
        el('div', { class: 'row mt-1 no-print' },
          el('button', { class: 'btn ghost sm', onclick: () => {
            downloadCsv('bulk-provisioned.csv', ['Name', 'Student ID', 'Username'],
              created.map((u) => [u.name, u.student_id, u.username]));
          } }, el('span', { class: 'ic' }, icons.download()), 'Export created accounts'),
          el('button', { class: 'btn ghost sm', onclick: () => {
            downloadCsv('bulk-skipped.csv', ['Student ID', 'Name', 'Reason'],
              skipped.map((s) => [s.student_id, s.name, s.reason]));
          } }, el('span', { class: 'ic' }, icons.download()), 'Export skipped')));
      toast(`${created.length} student accounts created${skipped.length ? ` · ${skipped.length} already existed (skipped)` : ''}.`, 'ok', 5000);
      parsed = null; fileInput.value = ''; updateBtn();
    } catch (e) {
      // ── failed mid-run — keep every result so far, tell the admin exactly where it stopped ──
      barFill.style.background = 'var(--danger)';
      statusLine.replaceChildren(el('span', { style: 'color:var(--danger)' },
        ` Stopped after ${all.created.length} created (${elapsed()}) — ${e.message}`));
      if (all.created.length > 0) {
        preview.replaceChildren(
          progress,
          el('div', { class: 'row wrap mt-1' },
            el('span', { class: 'chip ok' }, ` ${all.created.length} created before the error`),
            el('span', { class: 'chip warn' }, 'Fix the problem, then run again — already-created students will simply be skipped')),
          el('div', { class: 'row mt-1 no-print' },
            el('button', { class: 'btn ghost sm', onclick: () => {
              downloadCsv('bulk-provisioned-partial.csv', ['Name', 'Student ID', 'Username'],
                all.created.map((u) => [u.name, u.student_id, u.username]));
            } }, el('span', { class: 'ic' }, icons.download()), 'Export accounts created so far')));
      }
      err.textContent = e.details?.length ? `${e.message} (needs ${e.details.join(', ')})` : e.message;
      createBtn.disabled = false; updateBtn();
    }
  }

  fileInput.addEventListener('change', () => fileInput.files[0] && readFile(fileInput.files[0]));

  return el('div', { class: 'card frame' }, el('div', { class: 'card-pad' },
    el('div', { class: 'card-title-row' },
      el('span', { class: 'ic', style: 'color:var(--gold-600)' }, icons.users()),
      el('h3', {}, 'Bulk Provision Students'),
      el('span', { class: 'sub' }, 'CSV / XLSX — one academic level per file')),
    el('div', { class: 'form-grid' },
      el('div', { class: 'field' }, el('label', {}, 'ACADEMIC LEVEL ', el('span', { class: 'req' }, '*')), level,
        el('div', { class: 'hint' }, 'Every account in the file gets this level.')),
      el('div', { class: 'field' }, el('label', {}, 'DEFAULT PASSWORD FOR ALL ', el('span', { class: 'req' }, '*')), pw)),
    el('div', { class: 'row mt-1 mb-1', style: 'align-items:flex-start' },
      el('div', { style: 'flex:1;min-width:0' }, drop),
      templateBtn),
    fileInput, preview, err, createBtn,
  ));
}

function pwField(onValid) {
  const pw = el('input', { class: 'input mono', type: 'text', placeholder: 'Temporary password' });
  const hint = el('div', { class: 'hint mt-1' });
  pw.addEventListener('input', () => {
    const p = passwordProblems(pw.value);
    hint.textContent = p.length ? `Needs ${p.join(', ')}.` : 'Meets the password policy ✓';
    hint.style.color = p.length ? 'var(--danger)' : 'var(--ok)';
    onValid(p.length === 0);
  });
  return el('div', { class: 'field' }, el('label', {}, 'TEMPORARY PASSWORD ', el('span', { class: 'req' }, '*')), pw, hint);
}

function teacherForm() {
  const name = el('input', { class: 'input', placeholder: 'Full name' });
  const email = el('input', { class: 'input', placeholder: 'name@shirejama.school' });
  const code = el('input', { class: 'input mono', placeholder: 'Leave blank to auto-generate (INST-…)' });
  const err = el('div', { class: 'err-line' });
  let pwOk = false;
  const pw = pwField((ok) => { pwOk = ok; });
  const result = el('div');
  return el('div', { class: 'card frame' }, el('div', { class: 'card-pad' },
    el('div', { class: 'card-title-row' }, el('span', { class: 'ic', style: 'color:var(--gold-600)' }, icons.users()), el('h3', {}, 'Teacher Account'), el('span', { class: 'sub' }, 'instructor')),
    el('div', { class: 'field' }, el('label', {}, 'FULL NAME ', el('span', { class: 'req' }, '*')), name),
    el('div', { class: 'field' }, el('label', {}, 'EMAIL ', el('span', { class: 'req' }, '*')), email),
    el('div', { class: 'field' }, el('label', {}, 'INSTRUCTOR CODE (OPTIONAL)'), code),
    pw, err, result,
    el('button', { class: 'btn primary mt-1', onclick: async () => {
      err.textContent = ''; result.replaceChildren();
      if (!pwOk) { err.textContent = 'Set a policy-compliant temporary password first.'; return; }
      try {
        const { user } = await api.post('/api/admin/teachers', {
          full_name: name.value, email: email.value, password: pw.querySelector('input').value,
          instructor_code: code.value || undefined,
        });
        result.replaceChildren(el('div', { class: 'chip ok mt-1' }, icons.checkCircle(),
          ` Created — username `, el('b', { class: 'mono' }, user.username),
          ' · code ', el('b', { class: 'mono' }, user.instructor_code)));
        name.value = email.value = code.value = '';
        toast('Teacher account provisioned.', 'ok');
      } catch (e) { err.textContent = e.details?.length ? `${e.message} (needs ${e.details.join(', ')})` : e.message; }
    } }, el('span', { class: 'ic' }, icons.userPlus()), 'Provision teacher'),
  ));
}

function studentForm() {
  const name = el('input', { class: 'input', placeholder: 'Full name' });
  const sid = el('input', { class: 'input mono', placeholder: 'Leave blank to auto-generate (STD-…)' });
  const level = el('select', { class: 'select' },
    el('option', { value: '' }, 'Select academic level…'),
    LEVELS.map((l) => el('option', { value: l }, LEVEL_LABELS[l])));
  const err = el('div', { class: 'err-line' });
  let pwOk = false;
  const pw = pwField((ok) => { pwOk = ok; });
  const result = el('div');
  return el('div', { class: 'card frame' }, el('div', { class: 'card-pad' },
    el('div', { class: 'card-title-row' }, el('span', { class: 'ic', style: 'color:var(--gold-600)' }, icons.award()), el('h3', {}, 'Student Account'), el('span', { class: 'sub' }, 'learner')),
    el('div', { class: 'field' }, el('label', {}, 'FULL NAME ', el('span', { class: 'req' }, '*')), name),
    el('div', { class: 'field' }, el('label', {}, 'STUDENT ID (OPTIONAL)'), sid,
      el('div', { class: 'hint' }, 'The student signs in with this ID. Blank = auto-generate.')),
    el('div', { class: 'field' }, el('label', {}, 'ACADEMIC LEVEL ', el('span', { class: 'req' }, '*')), level,
      el('div', { class: 'hint' }, 'Determines which courses the student sees.')),
    pw, err, result,
    el('button', { class: 'btn primary mt-1', onclick: async () => {
      err.textContent = ''; result.replaceChildren();
      if (!level.value) { err.textContent = 'Choose an academic level.'; return; }
      if (!pwOk) { err.textContent = 'Set a policy-compliant temporary password first.'; return; }
      try {
        const { user } = await api.post('/api/admin/students', {
          full_name: name.value, student_id: sid.value || undefined, academic_level: level.value,
          password: pw.querySelector('input').value,
        });
        result.replaceChildren(el('div', { class: 'chip ok mt-1' }, icons.checkCircle(),
          ` Created — the student signs in with ID `, el('b', { class: 'mono' }, user.student_id),
          ' · password ', el('b', { class: 'mono' }, 'the one you set')));
        name.value = sid.value = ''; level.value = '';
        toast('Student account registered.', 'ok');
      } catch (e) { err.textContent = e.details?.length ? `${e.message} (needs ${e.details.join(', ')})` : e.message; }
    } }, el('span', { class: 'ic' }, icons.userPlus()), 'Register student'),
  ));
}

/* ── Backup Console — admin-connected S3-compatible cloud storage ─────── */
async function renderBackups(main) {
  const { config, history } = await api.get('/api/admin/backups');
  const histWrap = el('div');
  const cfg = { ...config };
  const s3 = config.s3;

  const drawHistory = (rows) => {
    histWrap.replaceChildren(rows.length === 0
      ? el('div', { class: 'empty' }, el('div', { class: 'e-ico' }, icons.archive()),
        el('h4', {}, 'No backups yet'), el('p', {}, 'Connect your storage, then run a backup or enable the schedule.'))
      : el('div', { class: 'table-wrap' }, el('table', { class: 'tbl' },
        el('thead', {}, el('tr', {}, ['File', 'Scope', 'Size', 'Taken', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, rows.map((b) => el('tr', {},
          el('td', { class: 'mono', style: 'font-size:11.5px' }, b.file_name),
          el('td', {}, el('span', { class: 'chip neutral' }, scopeLabel(b.scope))),
          el('td', { class: 'mono' }, fmtBytes(b.size_bytes)),
          el('td', {}, fmtDateTime(b.created_at)),
          el('td', {}, el('div', { class: 'row-actions' },
            el('a', { class: 'icon-btn', href: `/api/admin/backups/${b.id}/download`, title: 'Download', download: b.file_name }, icons.download()),
            el('button', { class: 'icon-btn', title: 'Delete backup', style: 'color:var(--danger)', onclick: async () => {
              const ok = await confirmDialog({ title: 'Delete this backup?', body: `“${b.file_name}” will be removed from your cloud storage.`, danger: true, confirmLabel: 'Delete' });
              if (!ok) return;
              await api.delete(`/api/admin/backups/${b.id}`); toast('Backup deleted.', 'ok');
              renderBackups(main);
            } }, icons.trash())))),
        )))));
  };

  const seg = (opts, key, onPick) => {
    const wrap = el('div', { class: 'seg', role: 'radiogroup' }, opts.map((o) =>
      el('button', { type: 'button', class: cfg[key] === o.value ? 'on' : '', role: 'radio',
        'aria-checked': cfg[key] === o.value ? 'true' : 'false',
        onclick: (e) => { cfg[key] = o.value; [...e.currentTarget.parentNode.children].forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); onPick?.(); } }, o.label)));
    return wrap;
  };

  // connection form (secret masked once saved)
  const endpoint = el('input', { class: 'input mono', placeholder: 'https://s3.amazonaws.com or https://nyc3.digitaloceanspaces.com', value: s3?.endpoint || '' });
  const region = el('input', { class: 'input mono', placeholder: 'auto', value: s3?.region || 'auto' });
  const bucket = el('input', { class: 'input mono', placeholder: 'your-bucket-name', value: s3?.bucket || '' });
  const accessKey = el('input', { class: 'input mono', placeholder: 'Access key ID', value: s3?.access_key_id || '' });
  const secret = el('input', { class: 'input mono', type: 'password', placeholder: s3 ? '******** (saved — leave as is)' : 'Secret access key' });
  const prefix = el('input', { class: 'input mono', placeholder: 'shirejama-backups (optional folder)', value: s3?.prefix || '' });

  const enabledToggle = el('input', { type: 'checkbox', checked: cfg.enabled });
  const retention = el('input', { class: 'input mono', type: 'number', min: '1', max: '200', value: cfg.retention });

  main.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('div', { class: 'eyebrow' }, 'Data Protection'),
        el('h1', {}, 'Backup Console'),
        el('div', { class: 'head-sub' }, 'Connect any S3-compatible cloud storage once — full system details (accounts, marks, progress) are backed up there automatically. Media files are never included.'))),
    el('div', { class: 'bk-grid' },
      el('div', { class: 'card frame' }, el('div', { class: 'card-pad' },
        el('div', { class: 'card-title-row' },
          el('span', { class: 'ic', style: 'color:var(--gold-600)' }, icons.database()),
          el('h3', {}, 'Cloud Storage Connection'),
          s3 && el('span', { class: 'chip ok' }, 'connected')),
        el('div', { class: 'field' }, el('label', {}, 'S3 ENDPOINT'), endpoint,
          el('div', { class: 'hint' }, 'Works with Amazon S3, Cloudflare R2, DigitalOcean Spaces, Backblaze B2, Wasabi, MinIO…')),
        el('div', { class: 'form-grid' },
          el('div', { class: 'field' }, el('label', {}, 'REGION'), region),
          el('div', { class: 'field' }, el('label', {}, 'BUCKET'), bucket)),
        el('div', { class: 'form-grid' },
          el('div', { class: 'field' }, el('label', {}, 'ACCESS KEY ID'), accessKey),
          el('div', { class: 'field' }, el('label', {}, 'SECRET ACCESS KEY'), secret)),
        el('div', { class: 'field' }, el('label', {}, 'PATH PREFIX (OPTIONAL)'), prefix),
        el('div', { class: 'row mt-1' },
          el('button', { class: 'btn primary', onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await api.put('/api/admin/backups/config', { s3: {
                endpoint: endpoint.value, region: region.value, bucket: bucket.value,
                access_key_id: accessKey.value, secret_access_key: secret.value,
                prefix: prefix.value } });
              toast('Storage connection saved.', 'ok'); renderBackups(main);
            } catch (err2) { toast(err2.message, 'err'); e.currentTarget.disabled = false; }
          } }, el('span', { class: 'ic' }, icons.settings()), 'Save connection'),
          el('button', { class: 'btn', onclick: async (e) => {
            e.currentTarget.disabled = true; e.currentTarget.textContent = 'Testing…';
            try { const r = await api.post('/api/admin/backups/test'); toast(r.message || 'Connected.', 'ok', 5000); }
            catch (err2) { toast(err2.message, 'err', 7000); }
            e.currentTarget.disabled = false;
            e.currentTarget.replaceChildren(el('span', { class: 'ic' }, icons.shield()), 'Test connection');
          } }, el('span', { class: 'ic' }, icons.shield()), 'Test connection')),
      )),
      el('div', {},
        el('div', { class: 'card frame mb-2' }, el('div', { class: 'card-pad' },
          el('h3', { class: 'mb-2' }, 'Schedule'),
          el('label', { class: 'check' }, enabledToggle,
            el('span', {}, el('b', {}, 'Automatic backups'), el('div', { class: 'hint' }, 'Off by default — runs only after you enable it.'))),
          el('div', { class: 'field mt-2' }, el('label', {}, 'FREQUENCY'),
            seg([{ label: 'Off', value: 'off' }, { label: 'Every 6h', value: '6h' }, { label: 'Daily', value: 'daily' }, { label: 'Weekly', value: 'weekly' }], 'frequency')),
          el('div', { class: 'field' }, el('label', {}, 'SCOPE'),
            seg([{ label: 'Accounts', value: 'accounts' }, { label: 'Results', value: 'results' }, { label: 'Everything', value: 'full' }], 'scope')),
          el('div', { class: 'hint', style: 'margin:-6px 0 14px' },
            'Accounts = logins & profiles · Results = marks, attempts & progress · Everything = the complete system data.'),
          el('div', { class: 'field' }, el('label', {}, 'KEEP LAST'), retention, el('div', { class: 'hint' }, 'Older backups are removed from your bucket automatically.')),
          el('div', { class: 'row mt-2' },
            el('button', { class: 'btn primary', onclick: async () => {
              try {
                await api.put('/api/admin/backups/config', { enabled: enabledToggle.checked, frequency: cfg.frequency, scope: cfg.scope, retention: Number(retention.value) });
                toast('Schedule saved.', 'ok');
              } catch (e) { toast(e.message, 'err'); }
            } }, el('span', { class: 'ic' }, icons.settings()), 'Save schedule'),
            el('button', { class: 'btn', onclick: async (e) => {
              e.currentTarget.disabled = true;
              try { const { backup } = await api.post('/api/admin/backups/run', { scope: cfg.scope }); toast(`Backup uploaded to your cloud storage (${fmtBytes(backup.size_bytes)}).`, 'ok', 5000); renderBackups(main); }
              catch (err2) { toast(err2.message, 'err', 7000); e.currentTarget.disabled = false; }
            } }, el('span', { class: 'ic' }, icons.refresh()), 'Backup now')),
          cfg.last_run && el('div', { class: 'hint mt-2' }, 'Last run: ', fmtDateTime(cfg.last_run),
            cfg.next_run && el('span', {}, ` · next: ${fmtDateTime(cfg.next_run)}`)),
        )),
        el('div', { class: 'card mb-2' }, el('div', { class: 'card-pad', style: 'padding:14px 18px' },
          el('div', { class: 'row' }, el('span', { class: 'ic', style: 'color:var(--gold-600)' }, icons.archive()),
            el('b', {}, 'Backup history'),
            el('span', { class: 'spacer' }),
            el('span', { class: 'hint' }, 'stored in your connected bucket')),
        histWrap)),
      )),
  );
  drawHistory(history);
}

const scopeLabel = (s) => ({ accounts: 'Accounts', results: 'Results', full: 'Everything' }[s] || s);

/* ── Analytics · teacher performance rollup ────────────────────────────── */
async function renderAnalytics(main) {
  const { summary, teachers } = await api.get('/api/admin/analytics/teachers');
  const bar = (pct, width = 90) => el('div', { style: `display:flex;align-items:center;gap:8px;min-width:${width}px` },
    el('div', { class: 'progressbar', style: 'flex:1' }, el('i', { style: `width:${Math.max(0, Math.min(100, pct ?? 0))}%` })),
    el('span', { class: 'mono', style: 'font-size:11px;color:var(--muted)' }, pct == null ? '—' : `${pct}%`));

  const rows = teachers.map((t) => el('tr', {},
    el('td', {}, el('b', {}, t.full_name),
      el('div', { class: 'faint mono', style: 'font-size:11px' }, t.instructor_code || ''),
      !t.is_active && el('span', { class: 'chip danger' }, 'inactive')),
    el('td', { class: 'mono' }, String(t.course_count)),
    el('td', { class: 'mono' }, `${t.chapter_count}`),
    el('td', { class: 'mono' }, String(t.material_count)),
    el('td', { class: 'mono' }, String(t.quiz_count)),
    el('td', { class: 'mono' }, `${t.students_engaged}`),
    el('td', { class: 'mono' }, String(t.attempt_count)),
    el('td', {}, bar(t.avg_score_pct == null ? null : Number(t.avg_score_pct))),
    el('td', {}, t.pending_grading > 0
      ? el('span', { class: 'chip warn' }, `${t.pending_grading} awaiting`)
      : el('span', { class: 'chip ok' }, 'clear')),
    el('td', { class: 'faint', style: 'font-size:11.5px' }, t.last_activity ? fmtDate(t.last_activity) : '—')));

  main.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('div', { class: 'eyebrow' }, 'Institution Insight'),
        el('h1', {}, 'Analytics'),
        el('div', { class: 'head-sub' }, 'How every instructor is building and how every cohort is performing.'))),
    el('div', { class: 'stat-grid mb-2' },
      stat('Courses Live', summary.courses, `${summary.materials} materials · ${summary.quizzes} quizzes`, 'book'),
      stat('Quiz Attempts', summary.attempts, `${summary.pendingGrading} awaiting grading`, 'inbox'),
      stat('Average Score', summary.avgScorePct == null ? '—' : `${summary.avgScorePct}%`, 'across released results', 'award'),
      stat('Teachers · Students', `${summary.teachers} · ${summary.students}`, 'active rosters', 'users')),
    teachers.length === 0
      ? el('div', { class: 'card frame' }, el('div', { class: 'empty' },
          el('div', { class: 'e-ico' }, icons.users()),
          el('h4', {}, 'No teachers yet'), el('p', {}, 'Provision teacher accounts to begin collecting analytics.')))
      : el('div', { class: 'table-wrap' }, el('table', { class: 'tbl' },
          el('thead', {}, el('tr', {}, ['Teacher', 'Courses', 'Chapters', 'Materials', 'Quizzes',
            'Students reached', 'Attempts', 'Avg score', 'Grading', 'Last activity'].map((h) => el('th', {}, h)))),
          el('tbody', {}, rows))),
  );
}
