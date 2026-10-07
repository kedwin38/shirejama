// ── Sequenced institutional identifiers (FR-3.1 / FR-3.2) ────────────────
// INST-101, INST-102 … / STD-<year>-1001, 1002 … allocated inside the
// caller's transaction so concurrent provisions cannot collide (UNIQUE
// constraints back this up as the final guard).

export async function nextInstructorCode(db) {
  const row = await db.prepare(`
    SELECT MAX(CAST(SUBSTR(instructor_code, 6) AS INTEGER)) AS m
    FROM users WHERE role='teacher' AND instructor_code LIKE 'INST-%'
  `).get();
  const next = Math.max(100, Number(row?.m ?? 100)) + 1;
  return `INST-${next}`;
}

export async function nextStudentId(db) {
  const year = new Date().getUTCFullYear();
  const row = await db.prepare(`
    SELECT MAX(CAST(SUBSTR(student_id, ?) AS INTEGER)) AS m
    FROM users WHERE role='student' AND student_id LIKE ?
  `).get(`${`STD-${year}-`.length + 1}`, `STD-${year}-%`);
  const next = Math.max(1000, Number(row?.m ?? 1000)) + 1;
  return `STD-${year}-${next}`;
}

const transliterate = (name) => name.toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);

/** Unique username from a full name: "Amina Yusuf" → amina.yusuf, amina.yusuf2 … */
export async function generateUsername(db, fullName) {
  const parts = transliterate(fullName);
  const base = (parts.length ? parts.join('.') : 'member').slice(0, 40);
  let candidate = base;
  let n = 2;
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE');
  while (await exists.get(candidate)) candidate = `${base}${n++}`;
  return candidate;
}
