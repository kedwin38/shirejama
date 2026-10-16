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

// Auto-minted Student IDs are PLAIN NUMBERS ("100001", "100002"…) — the
// institution's own IDs are stored exactly as provided, so generated ones
// must follow the same clean, hyphen-and-prefix-free format.
export async function nextStudentId(db) {
  const row = await db.prepare(`
    SELECT MAX(CAST(student_id AS INTEGER)) AS m
    FROM users WHERE role='student'
      AND student_id GLOB '[0-9]*' AND student_id NOT GLOB '*[^0-9]*'
  `).get();
  const next = Math.max(100000, Number(row?.m ?? 100000)) + 1;
  return String(next);
}

const transliterate = (name) => name.toLowerCase()
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);

/** Base username for a full name: "Amina Yusuf" → "amina.yusuf". Pure. */
export const usernameBase = (fullName) => {
  const parts = transliterate(fullName);
  return (parts.length ? parts.join('.') : 'member').slice(0, 40);
};

/** Allocate a unique username from a base against a lowercased taken-set. Pure. */
export const allocateUsername = (base, takenLc) => {
  let candidate = base;
  let n = 2;
  while (takenLc.has(candidate.toLowerCase())) candidate = `${base}${n++}`;
  return candidate;
};

/** Unique username from a full name: "Amina Yusuf" → amina.yusuf, amina.yusuf2 … */
export async function generateUsername(db, fullName) {
  const base = usernameBase(fullName);
  const exists = db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE');
  let candidate = base;
  let n = 2;
  while (await exists.get(candidate)) candidate = `${base}${n++}`;
  return candidate;
}
