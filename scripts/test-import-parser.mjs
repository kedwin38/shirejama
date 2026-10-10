// Parser unit tests: CSV edge cases + a real (deflated) XLSX fixture built
// with a minimal ZIP writer, exercising the same public/js parser the
// browser uses.
import { deflateRawSync } from 'node:zlib';
import { parseStudentsFile, parseCsv } from '../public/js/lib/student-import.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name); } };

/* ── CSV ──────────────────────────────────────────────────────────────── */
const csv = await parseStudentsFile({
  name: 'list.csv',
  text: 'Name,Student_ID\n"Yusuf, Ali",STD-2026-2001\n  Halima Omar  , std-2026-2002 \nBad Row,X\n,\nJina Moja,STD-2026-2003',
});
ok('csv: 3 valid rows', csv.rows.length === 3);
ok('csv: quoted comma name intact', csv.rows[0].name === 'Yusuf, Ali');
ok('csv: trims + uppercases student id', csv.rows[1].student_id === 'STD-2026-2002');
ok('csv: short name flagged invalid', csv.invalid.length === 1 && csv.invalid[0].student_id === 'X');

const semi = parseCsv('a;b\n1;2');
ok('csv: semicolon delimiter', semi[1][1] === '2');

/* ── XLSX fixture (shared strings + deflate, like real Excel) ─────────── */
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
const file = (name, content, method) => {
  const data = Buffer.from(content, 'utf8');
  const comp = method === 8 ? deflateRawSync(data) : data;
  return { name, data, comp, method, crc: crc32(comp) };
};
const buildZip = (files) => {
  const enc = new TextEncoder();
  let local = Buffer.alloc(0), central = Buffer.alloc(0), offset = 0;
  for (const f of files) {
    const nb = Buffer.from(enc.encode(f.name));
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(f.method, 8);
    lh.writeUInt32LE(f.crc, 14); lh.writeUInt32LE(f.comp.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(f.method, 10);
    ch.writeUInt32LE(f.crc, 16); ch.writeUInt32LE(f.comp.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(offset, 42);
    local = Buffer.concat([local, lh, nb, f.comp]);
    central = Buffer.concat([central, ch, nb]);
    offset += 30 + nb.length + f.comp.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return new Uint8Array(Buffer.concat([local, central, eocd])).buffer;
};

const sharedXml = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
  + ['Name', 'Student_ID', 'Amina Yusuf', 'STD-2026-3001', 'Botan Ahmed', 'STD-2026-3002']
    .map((s) => `<si><t>${s}</t></si>`).join('') + '</sst>';
const sheetXml = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`
  + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
  + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row>'
  + '<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" t="s"><v>5</v></c></row>'
  + '<row r="4"><c r="A4"><is><t>Said Inline</t></is></c><c r="B4"><v>2026-3003</v></c></row>'
  + '</sheetData></worksheet>';
const xlsx = buildZip([
  file('[Content_Types].xml', '<Types/>', 0),
  file('xl/sharedStrings.xml', sharedXml, 8),   // DEFLATED like Excel
  file('xl/worksheets/sheet1.xml', sheetXml, 8),
]);
const xres = await parseStudentsFile({ name: 'list.xlsx', buffer: xlsx });
ok('xlsx: 3 students parsed', xres.rows.length === 3);
ok('xlsx: header row skipped via shared strings', xres.rows[0].name === 'Amina Yusuf');
ok('xlsx: shared-string student id', xres.rows[0].student_id === 'STD-2026-3001');
ok('xlsx: inline string + numeric cell', xres.rows[2].name === 'Said Inline'
  && xres.rows[2].student_id === '2026-3003');

console.log(`\n${pass} passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
