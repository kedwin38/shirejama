// ── Hash router with params + optional View Transitions ──────────────────
const listeners = new Set();
let current = parseHash();

function parseHash() {
  const raw = (location.hash || '#/gate').slice(1);
  const [path, qs] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  return { path, parts, query, raw };
}

export function navigate(path, { replace = false } = {}) {
  const target = '#' + (path.startsWith('/') ? path : '/' + path);
  if (replace) location.replace(target);
  else location.hash = target;
}

export function getRoute() { return current; }

export function startRouter() {
  const fire = () => {
    const prev = current;
    current = parseHash();
    const apply = () => { for (const fn of listeners) fn(current, prev); };
    if (document.startViewTransition && prev.raw !== current.raw) {
      document.startViewTransition(apply);
    } else apply();
  };
  window.addEventListener('hashchange', fire);
  // Defer the initial dispatch so listeners registered right after
  // startRouter() are guaranteed to receive it (queueMicrotask survives
  // module-load order without waiting a full tick of painting).
  queueMicrotask(fire);
}

export function onRoute(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Link helper: '#/teacher/courses/3' → returns 'teacher.courses.3' style key */
export const routeKey = (r) => r.parts.join('.') || 'gate';
