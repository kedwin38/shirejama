// ── UI primitives: dom builder, icons, toasts, modals, formatting ────────

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'value') node.value = v;
    else if (k === 'checked') node.checked = !!v;
    else if (k === 'disabled') node.disabled = !!v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  f.append(...children.flat(Infinity).filter(Boolean));
  return f;
};

/* ── Inline icon set (stroke = currentColor) ───────────────────────────── */
const I = (paths, vb = '0 0 24 24') => (cls) => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', vb); s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('class', cls || 'ic'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = paths;
  return s;
};
export const icons = {
  home: I('<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M10 20v-5h4v5"/>'),
  users: I('<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5c.6-3.2 2.8-5 5.5-5s4.9 1.8 5.5 5"/><circle cx="17" cy="9.5" r="2.4"/><path d="M16 14.6c2.3.2 3.9 1.7 4.4 4.4"/>'),
  userPlus: I('<circle cx="9.5" cy="8" r="3.4"/><path d="M3.5 20c.7-3.4 3-5.3 6-5.3s5.3 1.9 6 5.3"/><path d="M18.5 8v6M15.5 11h6"/>'),
  shield: I('<path d="M12 3.5 5 6v5.5c0 4.6 3 7.6 7 9 4-1.4 7-4.4 7-9V6z"/><path d="m9 11.5 2.2 2.2L15.5 9"/>'),
  book: I('<path d="M4 5.5C7 4 9.5 4 12 5.8c2.5-1.8 5-1.8 8-.3V18c-3-1.5-5.5-1.5-8 .3-2.5-1.8-5-1.8-8-.3z"/><path d="M12 5.8V18.3"/>'),
  layers: I('<path d="m12 3.5 9 4.7-9 4.7-9-4.7z"/><path d="m4.5 12.5 7.5 3.9 7.5-3.9"/><path d="m4.5 16.5 7.5 3.9 7.5-3.9"/>'),
  quiz: I('<path d="M5 4.5h14v15H5z"/><path d="M8.5 9h7M8.5 12.5h7M8.5 16h4"/><circle cx="16.6" cy="16.4" r="2.6"/><path d="m18.6 18.4 1.6 1.6"/>'),
  video: I('<rect x="3" y="6" width="12.5" height="12" rx="2.5"/><path d="m15.5 10.6 5-2.8v8.4l-5-2.8z"/>'),
  pdf: I('<path d="M7 3.5h7l4.5 4.5v12.5H7z"/><path d="M14 3.5V8h4.5"/><path d="M9.5 16v-4h1.4a1.3 1.3 0 0 1 0 2.6H9.5"/><path d="M13.5 16v-4h.8a1.7 1.7 0 0 1 1.7 2 1.7 1.7 0 0 1-1.7 2h-.8z"/>'),
  check: I('<path d="m4.5 12.5 5 5L19.5 7"/>'),
  checkCircle: I('<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.8 2.7L16.5 9"/>'),
  xCircle: I('<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/>'),
  x: I('<path d="M6 6l12 12M18 6 6 18"/>'),
  clock: I('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2.5"/>'),
  calendar: I('<rect x="4" y="5.5" width="16" height="15" rx="2"/><path d="M8 3.5v4M16 3.5v4M4 10.5h16"/>'),
  upload: I('<path d="M12 15.5v-11M7.5 9 12 4.5 16.5 9"/><path d="M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/>'),
  download: I('<path d="M12 4.5v11M7.5 11 12 15.5 16.5 11"/><path d="M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/>'),
  trash: I('<path d="M4.5 6.5h15M9.5 6V4.5h5V6M6.5 6.5l1 14h9l1-14"/><path d="M10 10.5v6M14 10.5v6"/>'),
  edit: I('<path d="M4.5 19.5h4L20 8a2.4 2.4 0 0 0-3.4-3.4L5 16.2z"/><path d="m14.5 7 3 3"/>'),
  plus: I('<path d="M12 5v14M5 12h14"/>'),
  arrowUp: I('<path d="M12 19V5m-6 6 6-6 6 6"/>'),
  arrowDown: I('<path d="M12 5v14m-6-6 6 6 6-6"/>'),
  arrowLeft: I('<path d="M19 12H5m6-6-6 6 6 6"/>'),
  play: I('<path d="m7 4.5 12 7.5-12 7.5z"/>'),
  key: I('<circle cx="8" cy="14.5" r="4.5"/><path d="m11.5 11 8-8M16 6.5l3 3M13.5 9l2.5 2.5"/>'),
  database: I('<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/><path d="M4 11.5v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>'),
  archive: I('<rect x="3.5" y="5" width="17" height="4" rx="1.2"/><path d="M5 9v9.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V9"/><path d="M10 13h4"/>'),
  sun: I('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.6M12 18.9v2.6M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12h2.6M18.9 12h2.6M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/>'),
  moon: I('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z"/>'),
  search: I('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>'),
  logout: I('<path d="M14.5 8V5.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2V16"/><path d="M9.5 12h11m-3-3 3 3-3 3"/>'),
  menu: I('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  chart: I('<path d="M4.5 20h15"/><path d="M7.5 20v-6M12 20V8M16.5 20v-9.5"/>'),
  award: I('<circle cx="12" cy="9" r="5.5"/><path d="m8.5 13.5-1.5 7 5-2.6 5 2.6-1.5-7"/>'),
  grid: I('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
  inbox: I('<path d="M4 13.5 6 5h12l2 8.5v5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/><path d="M4 13.5h4l1 2.5h6l1-2.5h4"/>'),
  command: I('<path d="M8.5 8.5V6a2.5 2.5 0 1 0-2.5 2.5zM8.5 8.5h7M8.5 8.5v7m7-7V6A2.5 2.5 0 1 1 18 8.5zM15.5 15.5V18a2.5 2.5 0 1 0 2.5-2.5zm0 0h-7m0 0V18a2.5 2.5 0 1 1-2.5-2.5z"/>'),
  eye: I('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>'),
  file: I('<path d="M7 3.5h7l4.5 4.5v12.5H7z"/><path d="M14 3.5V8h4.5"/>'),
  refresh: I('<path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 3.5V8h-4.5"/>'),
  settings: I('<circle cx="12" cy="12" r="3"/><path d="M12 2.8 13.9 5a7.2 7.2 0 0 1 2.6 1.1l2.8-.6.8 2.7-2 2a7.4 7.4 0 0 1 0 2.6l2 2-.8 2.7-2.8-.6a7.2 7.2 0 0 1-2.6 1.1L12 21.2 10.1 19a7.2 7.2 0 0 1-2.6-1.1l-2.8.6-.8-2.7 2-2a7.4 7.4 0 0 1 0-2.6l-2-2 .8-2.7 2.8.6A7.2 7.2 0 0 1 10.1 5z"/>'),
};

/* ── Toasts ─────────────────────────────────────────────────────────────── */
export function toast(message, kind = 'info', ms = 4200) {
  const host = document.getElementById('toasts');
  const t = el('div', { class: `toast ${kind}`, role: 'status' },
    el('span', { class: 't-ico' }, kind === 'ok' ? icons.checkCircle() : kind === 'err' ? icons.xCircle() : icons.award()),
    el('div', {}, message));
  host.append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, ms);
}

/* ── Modal & confirm ────────────────────────────────────────────────────── */
const modalDlg = () => document.getElementById('modal-root');
const modalCard = () => document.getElementById('modal-card');

export function openModal(build, { wide = false } = {}) {
  const dlg = modalDlg(), card = modalCard();
  card.className = 'modal-card' + (wide ? ' wide' : '');
  card.replaceChildren();

  // Always settle the 'modal-result' promise when the dialog closes — by
  // done(), the ✕ button, Escape, or a backdrop click — so awaiting code
  // (confirmDialog) never hangs.
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    card.dispatchEvent(new CustomEvent('modal-result', { detail: result }));
  };

  dlg.addEventListener('close', () => finish(undefined), { once: true });
  if (!dlg._backdropWired) {
    dlg._backdropWired = true;
    // Click on the backdrop (the <dialog> itself, outside the card) cancels.
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  }

  const done = (result) => { finish(result); dlg.close(); };
  build(card, done);
  if (!dlg.open) dlg.showModal();
  dlg.querySelector('[data-autofocus]')?.focus();
  return dlg;
}
export function closeModal() { modalDlg().close(); }

/** Promise-based confirm dialog. */
export function confirmDialog({ title, body, danger = false, confirmLabel = 'Confirm', cancelLabel = 'Cancel' }) {
  return new Promise((resolve) => {
    openModal((card, done) => {
      card.append(
        el('div', { class: 'modal-head' },
          el('h3', {}, title),
          el('button', { class: 'icon-btn x', 'aria-label': 'Close', onclick: () => done(false) }, icons.x())),
        el('div', { class: 'modal-body' }, typeof body === 'string' ? body : body),
        el('div', { class: 'modal-foot' },
          el('button', { class: 'btn ghost', onclick: () => done(false) }, cancelLabel),
          el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, 'data-autofocus': true, onclick: () => done(true) }, confirmLabel)),
      );
      card.addEventListener('modal-result', (e) => resolve(e.detail), { once: true });
    });
  });
}

/* ── Theater (full-bleed PDF / video) ───────────────────────────────────── */
export function openTheater(build) {
  const dlg = document.getElementById('theater-root');
  const card = document.getElementById('theater-card');
  card.replaceChildren();
  build(card, () => dlg.close());
  if (!dlg.open) dlg.showModal();
}

/* ── Formatting ─────────────────────────────────────────────────────────── */
const dtf = (opts) => new Intl.DateTimeFormat(undefined, opts);
export const fmtDate = (iso) => iso ? dtf({ day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)) : '—';
export const fmtDateTime = (iso) => iso ? dtf({ day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '—';
export function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
export const fmtPct = (a, b) => b ? `${Math.round((a / b) * 100)}%` : '—';
export function fmtScore(score, max) {
  if (score == null) return '—';
  const pct = max ? Math.round((score / max) * 100) : 0;
  return `${Math.round(score * 10) / 10} / ${max} · ${pct}%`;
}
export const initials = (name) => (name || '?').split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();
export function countdownText(msLeft) {
  if (msLeft == null) return '';
  const s = Math.max(0, Math.floor(msLeft / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
}
export const LEVEL_LABELS = {
  C1:'Class 1',C2:'Class 2',C3:'Class 3',C4:'Class 4',C5:'Class 5',C6:'Class 6',C7:'Class 7',C8:'Class 8',
  F1:'Form 1',F2:'Form 2',F3:'Form 3',F4:'Form 4',
};
export const levelChip = (l) => el('span', { class: 'chip neutral mono' }, LEVEL_LABELS[l] || l);

/* password policy check shared with the server rules */
export function passwordProblems(pw) {
  const p = [];
  if (!pw || pw.length < 8) p.push('at least 8 characters');
  if (!/[a-z]/.test(pw || '')) p.push('a lowercase letter');
  if (!/[A-Z]/.test(pw || '')) p.push('an uppercase letter');
  if (!/[0-9]/.test(pw || '')) p.push('a digit');
  return p;
}

/* upload with progress via XHR (fetch cannot report progress) */
export function uploadWithProgress({ method = 'PUT', url, body, headers = {}, onProgress }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('X-Requested-With', 'fetch');
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(Object.assign(new Error(data?.error?.message || `Upload failed (${xhr.status})`),
        { status: xhr.status, code: data?.error?.code, details: data?.error?.details }));
    };
    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.send(body);
  });
}

/* ── CSV export (client-side, spreadsheet-ready) ────────────────────────── */
export function downloadCsv(filename, headers, rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers, ...rows].map((r) => r.map(esc).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
