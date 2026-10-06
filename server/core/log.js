// ── Structured console logger (JSON lines, greppable) ───────────────────
const ts = () => new Date().toISOString();
export const log = {
  info: (event, data = {}) => console.log(JSON.stringify({ t: ts(), lvl: 'info', event, ...data })),
  warn: (event, data = {}) => console.log(JSON.stringify({ t: ts(), lvl: 'warn', event, ...data })),
  error: (event, data = {}) => console.error(JSON.stringify({ t: ts(), lvl: 'error', event, ...data })),
};
