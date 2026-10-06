// ── Tiny PDF writer for seed content (valid PDF 1.4, Helvetica) ──────────
// Escaping and xref offsets are computed exactly; viewers accept the result.
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function makePdf({ title, subtitle = '', lines = [] }) {
  const content = [];
  let y = 740;
  content.push('BT /F2 20 Tf 72 ' + y + ' Td (' + esc(title) + ') Tj ET');
  y -= 26;
  if (subtitle) {
    content.push('BT /F1 11 Tf 72 ' + y + ' Td (' + esc(subtitle) + ') Tj ET');
    y -= 30;
  } else {
    y -= 10;
  }
  content.push('0.76 0.65 0.06 RG 2 w 72 ' + y + ' m 540 ' + y + ' l S');
  y -= 26;
  for (const line of lines) {
    if (line === '') { y -= 12; continue; }
    const isHeading = line.startsWith('# ');
    const text = isHeading ? line.slice(2) : line;
    if (isHeading) { y -= 8; content.push('BT /F2 13 Tf 72 ' + y + ' Td (' + esc(text) + ') Tj ET'); y -= 20; }
    else { content.push('BT /F1 11 Tf 72 ' + y + ' Td (' + esc(text) + ') Tj ET'); y -= 16; }
    if (y < 60) break;
  }

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
      + '/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    '<< /Length ' + Buffer.byteLength(content.join('\n')) + ' >>\nstream\n'
      + content.join('\n') + '\nendstream',
  ];

  let pdf = Buffer.from('%PDF-1.4\n');
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf = Buffer.concat([pdf, Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`)]);
  });
  const xrefPos = pdf.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += String(off).padStart(10, '0') + ' 00000 n \n';
  pdf = Buffer.concat([pdf, Buffer.from(
    xref + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`)]);
  return pdf;
}
