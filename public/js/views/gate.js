// ── Gate · Sign In / Portal Access (FR-1.1 / FR-1.2) ─────────────────────
import { api } from '../lib/api.js';
import { el, icons, toast } from '../lib/ui.js';

const ROLES = [
  { id: 'student', label: 'Student', desc: 'Learn, watch, read & take quizzes', letter: 'S' },
  { id: 'teacher', label: 'Teacher', desc: 'Author courses & grade work', letter: 'T' },
  { id: 'admin', label: 'Administrator', desc: 'Accounts, institution & backups', letter: 'A' },
];

export function renderGate(app, onAuthed) {
  let selectedRole = null;

  const roleCards = el('div', { class: 'role-cards', role: 'radiogroup', 'aria-label': 'Select your role' },
    ROLES.map((r) => el('div', {
      class: 'role-card', role: 'radio', 'aria-checked': 'false', tabindex: '0',
      onclick: () => selectRole(r.id),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRole(r.id); } },
    },
      el('div', { class: 'rc-ring ring-seal' }, r.letter),
      el('div', { class: 'rc-name' }, r.label),
      el('div', { class: 'rc-desc' }, r.desc),
    )));

  const identifier = el('input', { class: 'input', placeholder: 'e.g. amina.yusuf or name@school.org', autocomplete: 'username', 'aria-label': 'Student ID, username, or email' });
  const password = el('input', { class: 'input', type: 'password', placeholder: 'Your password', autocomplete: 'current-password', 'aria-label': 'Password' });
  const errLine = el('div', { class: 'err-line', role: 'alert' });
  const submitBtn = el('button', { class: 'btn primary lg', style: 'width:100%', type: 'submit', disabled: true },
    el('span', { class: 'ic' }, icons.key()), 'Sign in to my portal');

  const formWrap = el('form', { class: 'gate-form', onsubmit: async (e) => {
    e.preventDefault();
    errLine.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in…';
    try {
      // Sign-in gets a shorter budget plus one automatic retry — a stalled
      // or hiccuped first attempt recovers instead of dead-ending the user.
      const { user } = await api.post('/api/auth/login', {
        role: selectedRole, identifier: identifier.value.trim(), password: password.value,
      }, { timeoutMs: 20_000, retries: 1 });
      toast(`Welcome, ${user.full_name}.`, 'ok');
      onAuthed(user);
    } catch (err) {
      errLine.textContent = err.message;
      submitBtn.replaceChildren(el('span', { class: 'ic' }, icons.key()), 'Sign in to my portal');
      submitBtn.disabled = false;
    }
  } },
    el('h1', {}, 'Sign In'),
    el('div', { class: 'gate-sub' }, 'Portal Access — select who you are, then authenticate.'),
    roleCards,
    el('div', { class: 'field' }, el('label', {}, 'USERNAME OR EMAIL'), identifier),
    el('div', { class: 'field' }, el('label', {}, 'PASSWORD'), password),
    errLine,
    submitBtn,
  );

  const intro = el('div', {},
    el('div', { class: 'gate-brand' },
      el('img', { src: '/assets/brand/seal.jpeg', alt: 'Shire Jama\'a Ahmed Adult School seal' })),
    el('div', { class: 'gate-center' },
      el('h2', { class: 'gate-motto' }, 'Education', el('br'), 'without ', el('em', {}, 'limits.')),
      el('p', { class: 'gate-proverb' },
        '“', el('b', {}, 'Aqoon la\'aan waa iftiin la\'aan.'), '” — Without knowledge, there is no light. ',
        'Somali proverb, honoured daily at Shire Jama\'a Ahmed Adult School.'),
    ),
    el('div', { class: 'gate-foot' }, 'Shire Jama LMS · Adult learning, anywhere on earth · UTC-aware coursework'),
  );

  function selectRole(id) {
    selectedRole = id;
    for (const card of roleCards.children) {
      const on = card.getAttribute('role') === 'radio' && ROLES.find((r) => r.label === card.querySelector('.rc-name').textContent).id === id;
      card.classList.toggle('selected', on);
      card.setAttribute('aria-checked', on ? 'true' : 'false');
    }
    identifier.placeholder = id === 'student'
      ? 'Your Student ID (e.g. STD-2026-1001)'
      : 'e.g. hodan.abdi or name@school.org';
    identifier.closest('.field').querySelector('label').textContent = id === 'student'
      ? 'STUDENT ID (OR USERNAME)' : 'USERNAME OR EMAIL';
    submitBtn.disabled = false;
    identifier.focus();
  }

  app.replaceChildren(
    el('div', { class: 'gate' },
      el('div', { class: 'gate-left sunburst' }, intro),
      el('div', { class: 'gate-right' }, el('div', { class: 'gate-panel' }, formWrap)),
    ),
  );
}
