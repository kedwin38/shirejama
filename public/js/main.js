// ── Shire Jama LMS · application shell ───────────────────────────────────
import { api } from './lib/api.js';
import { startRouter, onRoute, navigate, getRoute } from './lib/router.js';
import { el, icons, toast, openModal, LEVEL_LABELS } from './lib/ui.js';
import { renderGate } from './views/gate.js';
import { renderAdmin, ADMIN_NAV } from './views/admin.js';
import { renderTeacher, TEACHER_NAV } from './views/teacher.js';
import { renderStudent, STUDENT_NAV } from './views/student.js';

const state = {
  user: null,
  theme: localStorage.getItem('sj-theme') || 'day',
};

const applyTheme = (t) => { document.body.dataset.theme = t; localStorage.setItem('sj-theme', t); };
applyTheme(state.theme);

/* ── Command palette (Ctrl+K) ──────────────────────────────────────────── */
function buildPaletteItems() {
  const items = [];
  const nav = state.user?.role === 'admin' ? ADMIN_NAV
    : state.user?.role === 'teacher' ? TEACHER_NAV : STUDENT_NAV;
  for (const n of nav) items.push({ label: n.label, icon: n.icon, hint: 'Go to', run: () => navigate(n.path) });
  items.push(
    { label: 'Toggle Day / Dusk theme', icon: 'sun', hint: 'Theme', run: () => { state.theme = state.theme === 'day' ? 'dusk' : 'day'; applyTheme(state.theme); } },
    { label: 'Sign out', icon: 'logout', hint: 'Account', run: doLogout },
  );
  return items;
}

function openPalette() {
  const items = buildPaletteItems();
  openModal((card, done) => {
    const list = el('div', { class: 'pal-list', role: 'listbox' });
    const input = el('input', { placeholder: 'Search actions… (Ctrl+K)', 'data-autofocus': true, 'aria-label': 'Command palette search' });
    let hl = 0;
    const renderList = () => {
      const q = input.value.trim().toLowerCase();
      const vis = items.filter((i) => !q || i.label.toLowerCase().includes(q));
      hl = Math.min(hl, Math.max(0, vis.length - 1));
      list.replaceChildren(...vis.map((it, idx) => el('div', {
        class: 'pal-item' + (idx === hl ? ' hl' : ''), role: 'option',
        onclick: () => { done(); it.run(); },
      }, el('span', { class: 'pi-ico' }, icons[it.icon]()), it.label, el('span', { class: 'pi-hint' }, it.hint))));
      list._visible = vis;
    };
    input.addEventListener('input', () => { hl = 0; renderList(); });
    input.addEventListener('keydown', (e) => {
      const vis = list._visible || [];
      if (e.key === 'ArrowDown') { e.preventDefault(); hl = Math.min(hl + 1, vis.length - 1); renderList(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); hl = Math.max(hl - 1, 0); renderList(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (vis[hl]) { done(); vis[hl].run(); } }
    });
    card.classList.add('palette');
    card.append(el('div', { class: 'palette-inner' }, input, list));
    renderList();
  });
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
});

/* ── Session ───────────────────────────────────────────────────────────── */
async function doLogout() {
  try { await api.post('/api/auth/logout'); } catch {}
  state.user = null;
  navigate('/gate');
  render();
}

window.addEventListener('api:unauthorized', () => {
  if (state.user) { state.user = null; toast('Your session has expired — please sign in again.', 'err'); navigate('/gate'); render(); }
});

/* ── Shell rendering ───────────────────────────────────────────────────── */
function renderShell() {
  const app = document.getElementById('app');
  const route = getRoute();
  const u = state.user;
  const nav = u.role === 'admin' ? ADMIN_NAV : u.role === 'teacher' ? TEACHER_NAV : STUDENT_NAV;
  const activeRoot = '/' + (route.parts[0] || nav[0].path.split('/')[1]);

  const navLinks = el('nav', { class: 'rail-nav', 'aria-label': 'Primary' },
    el('div', { class: 'rail-label' }, { admin: 'Administration', teacher: 'Teacher Portal', student: 'Learning Portal' }[u.role]),
    nav.map((n) => el('a', {
      href: '#' + n.path,
      class: route.parts[0] === n.path.split('/')[1] ? 'active' : '',
      'aria-current': route.parts[0] === n.path.split('/')[1] ? 'page' : null,
    }, el('span', { class: 'ic' }, icons[n.icon]()), n.label,
      n.count != null ? el('span', { class: `rail-count${n.count ? '' : ' gray'}` }, String(n.count)) : null)),
  );

  const main = el('div', { class: 'main manuscript', id: 'main-outlet' });
  const roleRender = { admin: renderAdmin, teacher: renderTeacher, student: renderStudent }[u.role];
  roleRender(main, route, state, refreshShell);

  const roleLabel = { admin: 'Administrator', teacher: 'Instructor', student: 'Student' }[u.role];
  app.replaceChildren(
    el('div', { class: 'shell' },
      el('header', { class: 'topbar weave' },
        el('button', { class: 'icon-btn menu-btn', title: 'Menu', 'aria-label': 'Open navigation menu',
          'aria-expanded': 'false', onclick: toggleRail }, icons.menu()),
        el('a', { class: 'wordmark', href: '#' + nav[0].path, 'aria-label': 'Shire Jama LMS home' },
          el('img', { src: '/assets/brand/mark.svg', alt: '' }),
          el('div', {}, el('div', { class: 'word-title' }, 'SHIRE JAMA LMS'),
            el('div', { class: 'word-sub' }, 'Education Without Limits'))),
        el('div', { class: 'crumbs', id: 'crumbs' }),
        el('div', { class: 'top-spacer' }),
        el('button', { class: 'icon-btn palette-btn', title: 'Command palette (Ctrl+K)', onclick: openPalette },
          icons.command(), el('span', { class: 'kbd' }, 'Ctrl K')),
        el('button', { class: 'icon-btn', title: 'Day / Dusk theme', onclick: () => { state.theme = state.theme === 'day' ? 'dusk' : 'day'; applyTheme(state.theme); } },
          state.theme === 'day' ? icons.moon() : icons.sun(), 'Theme'),
        el('div', { class: 'userchip', id: 'userchip', role: 'button', tabindex: '0', title: 'Account' },
          el('span', { class: 'avatar' }, (u.full_name || '?').slice(0, 1).toUpperCase()),
          el('span', {}, el('div', { class: 'uname' }, u.full_name),
            el('div', { class: 'urole' }, roleLabel + (u.academic_level ? ` · ${LEVEL_LABELS[u.academic_level]}` : '')))),
        el('button', { class: 'icon-btn', title: 'Sign out', onclick: doLogout }, icons.logout()),
      ),
      el('div', { class: 'shell-body' },
        el('aside', { class: 'rail weave', id: 'rail' }, navLinks,
          el('div', { class: 'rail-foot' },
            el('b', {}, 'SHIRE JAMA\'A AHMED'),
            el('br'), 'Adult School · LMS v1.0',
            el('br'),
            el('a', { href: 'https://www.vervevector.digital', target: '_blank', rel: 'noopener',
              style: 'text-decoration:underline' }, 'Developed by vervevector')),
        el('div', { class: 'rail-scrim', id: 'rail-scrim', onclick: toggleRail }),
        main),
    ),
  );
  document.getElementById('userchip').addEventListener('click', openAccountMenu);
  document.getElementById('userchip').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAccountMenu(); } });
}

/* ── Mobile navigation drawer ─────────────────────────────────────────── */
function toggleRail(force) {
  const rail = document.getElementById('rail');
  const scrim = document.getElementById('rail-scrim');
  if (!rail || !scrim) return;
  const open = typeof force === 'boolean' ? force : !rail.classList.contains('open');
  rail.classList.toggle('open', open);
  scrim.classList.toggle('show', open);
  document.body.classList.toggle('rail-open', open);
  const btn = document.querySelector('.menu-btn');
  if (btn) btn.setAttribute('aria-expanded', String(open));
}
// close the drawer on any navigation and on Escape
window.addEventListener('hashchange', () => toggleRail(false));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') toggleRail(false);
});

function openAccountMenu() {
  openModal((card, done) => {
    const cur = el('input', { class: 'input', type: 'password', placeholder: 'Current password', 'data-autofocus': true });
    const next = el('input', { class: 'input', type: 'password', placeholder: 'New password' });
    const err = el('div', { class: 'err-line' });
    card.append(
      el('div', { class: 'modal-head' }, el('h3', {}, 'My Account'),
        el('button', { class: 'icon-btn x', 'aria-label': 'Close', onclick: () => done() }, icons.x())),
      el('div', { class: 'modal-body' },
        el('div', { class: 'row wrap mb-2' },
          el('span', { class: 'chip neutral mono' }, state.user.username),
          state.user.instructor_code && el('span', { class: 'chip gold mono' }, state.user.instructor_code),
          state.user.student_id && el('span', { class: 'chip gold mono' }, state.user.student_id)),
        el('div', { class: 'field' }, el('label', {}, 'CURRENT PASSWORD'), cur),
        el('div', { class: 'field' }, el('label', {}, 'NEW PASSWORD'),
          next, el('div', { class: 'hint' }, 'Min 8 chars with upper, lower, and a digit.')),
        err),
      el('div', { class: 'modal-foot' },
        el('button', { class: 'btn ghost', onclick: () => done() }, 'Cancel'),
        el('button', { class: 'btn primary', onclick: async () => {
          err.textContent = '';
          try {
            await api.post('/api/auth/change-password', { current: cur.value, next: next.value });
            toast('Password changed.', 'ok'); done();
          } catch (e) { err.textContent = e.message; }
        } }, el('span', { class: 'ic' }, icons.key()), 'Change password')),
    );
  });
}

/* counts refresh (badges) */
async function refreshShell() { renderShell(); }

/* views request a reload after mutations */
document.addEventListener('reload-view', () => render());

/* ── Router dispatch ───────────────────────────────────────────────────── */
function render() {
  const app = document.getElementById('app');
  const route = getRoute();
  window.SJ_USER = state.user; // lightweight access for portal subtitles
  if (!state.user) { renderGate(app, async (user) => { state.user = user; navigate(`/${user.role}`); render(); }); return; }
  const validRoots = ['admin', 'teacher', 'student'];
  if (!validRoots.includes(route.parts[0])) { navigate('/' + state.user.role, { replace: true }); return; }
  if (route.parts[0] !== state.user.role) { navigate('/' + state.user.role, { replace: true }); return; }
  renderShell();
}

async function boot() {
  try { const { user } = await api.get('/api/auth/me'); state.user = user; } catch { state.user = null; }
  onRoute(render);            // register before the router's initial dispatch
  startRouter();
  if (!location.hash || location.hash === '#/') navigate('/' + (state.user ? state.user.role : 'gate'), { replace: true });
}
boot();
