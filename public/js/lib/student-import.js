// ── Student list import · CSV & XLSX parser ──────────────────────────────
// Runs entirely client-side (browser) and in Node for tests — no
// dependencies. Extracts {name, student_id} rows; never touches the server
// with raw file bytes (the provision API takes parsed rows only).
//
// XLSX support is a minimal OOXML reader: walk the ZIP central directory,
// inflate entries (Stored or Deflate via DecompressionStream), then read
// xl/sharedStrings.xml + the first worksheet. Handles shared strings,
// inline strings, and numeric cells.

const MAX_ROWS = 5000;

const decodeEntities = (s) => s
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/* ── CSV ─────────────────────────────────────────────────────────────── */
export function parseCsv(text) {
  const src = text.replace(/^\uFEFF/, '');
  const rows = [];
  let cur = [''], inQ = false, r = 0, c = 0;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cur[c] += '"'; i++; }
        else inQ = false;
      } else cur[c] += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { cur.push(''); c++; }
    else if (ch === '\r') { /* CRLF tolerant */ }
    else if (ch === '\n') { rows.push(cur); cur = ['']; c = 0; r++; }
    else cur[c] += ch;
  }
  if (cur.length > 1 || cur[0] !== '') rows.push(cur);
  return rows.map((row) => row.map((v) => v.trim()));
}

/* ── ZIP (for XLSX) ──────────────────────────────────────────────────── */
function zipEntries(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  // find End Of Central Directory (scan backwards, classic max-comment 64K)
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP/XLSX file.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];
  const td = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compSize, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { u8, dv, entries };
}

async function zipRead(archive, name) {
  const e = archive.entries.find((x) => x.name === name);
  if (!e) return null;
  const { u8, dv } = archive;
  // local file header: skip its (own) name+extra lengths to reach the data
  if (dv.getUint32(e.localOff, true) !== 0x04034b50) return null;
  const nLen = dv.getUint16(e.localOff + 26, true);
  const xLen = dv.getUint16(e.localOff + 28, true);
  const start = e.localOff + 30 + nLen + xLen;
  const comp = u8.subarray(start, start + e.compSize);
  if (e.method === 0) return new TextDecoder().decode(comp); // Stored
  if (e.method === 8) { // Deflate
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([comp]).stream().pipeThrough(ds);
    return await new Response(stream).text();
  }
  throw new Error('Unsupported ZIP compression method ' + e.method);
}

/* ── XLSX ────────────────────────────────────────────────────────────── */
const colToIndex = (letters) => {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

export async function parseXlsx(buf) {
  const archive = zipEntries(buf);  const sharedRaw = await zipRead(archive, 'xl/sharedStrings.xml');
  const shared = [];
  if (sharedRaw) {
    for (const si of sharedRaw.split(/<\/si>/)) {
      const m = si.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g);
      if (m) shared.push(decodeEntities(m.map((t) => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }
  const sheetName = archive.entries
    .map((e) => e.name)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0];
  if (!sheetName) throw new Error('No worksheet found in the XLSX file.');
  const sheet = await zipRead(archive, sheetName);

  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(sheet)) !== null && rows.length <= MAX_ROWS) {
    const cells = [];
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*?)\/>/g;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      const attrs = cellMatch[1] ?? cellMatch[3] ?? '';
      const body = cellMatch[2] ?? '';
      const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const type = /t="(\w+)"/.exec(attrs)?.[1];
      let val = '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      const is = /<is>[\s\S]*?<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(body)?.[1];
      if (type === 's' && v != null) val = shared[Number(v)] ?? '';
      else if (is != null) val = decodeEntities(is); // inlineStr (some writers omit t="inlineStr")
      else if (v != null) val = decodeEntities(v);
      if (ref) cells[colToIndex(ref)] = val;
    }
    // fill gaps so indexes line up
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells.map((v) => (v ?? '').trim()));
  }
  return rows;
}

/* ── Shared: rows → students ─────────────────────────────────────────── */
function rowsToStudents(rows) {
  const invalid = [];
  const students = [];
  let start = 0;
  // header heuristic: first row labels the columns
  const first = (rows[0] ?? []).join(' ').toLowerCase();
  if (/name|jina|student|adm/.test(first) && !first.includes('@')) start = 1;

  for (let i = start; i < rows.length && students.length < MAX_ROWS; i++) {
    const [name, student_id, ...extra] = rows[i];
    if (!name && !student_id) continue; // blank line
    const row = { row: i + 1, name: name ?? '', student_id: (student_id ?? '').trim() };
    if (row.name.length < 3) { invalid.push({ ...row, reason: 'Name must be 3–120 characters.' }); continue; }
    if (row.student_id.length < 3 || row.student_id.length > 40 || row.student_id.includes('@')) {
      invalid.push({ ...row, reason: 'Student ID must be 3–40 letters/digits/hyphens.' }); continue;
    }
    students.push({ name: row.name.trim(), student_id: row.student_id.toUpperCase().replace(/\s+/g, '') });
  }
  return { rows: students, invalid };
}

/** Parse a student list file → { rows, invalid }. Accepts .csv/.xlsx/.xls text or ArrayBuffer. */
export async function parseStudentsFile({ name, text, buffer }) {
  const isX = /\.xlsx?$/i.test(name ?? '');
  if (isX && buffer) return rowsToStudents(await parseXlsx(buffer));
  if (!isX && text != null) return rowsToStudents(parseCsv(text));
  if (isX && text != null) return rowsToStudents(parseCsv(text)); // .xls saved as text
  throw new Error('Provide the file as text or an ArrayBuffer.');
}
