// One-time asset vendor script: downloads WOFF2 fonts from Google Fonts
// into public/assets/fonts with stable filenames. Not needed at runtime.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'public/assets/fonts');
mkdirSync(OUT, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const families = [
  { q: 'Oswald:wght@500;600;700', prefix: 'oswald' },
  { q: 'Inter:wght@400;500;600;700', prefix: 'inter' },
  { q: 'JetBrains+Mono:wght@400;600', prefix: 'jbmono' },
];

for (const fam of families) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${fam.q}&display=swap`;
  const res = await fetch(cssUrl, { headers: { 'User-Agent': UA } });
  if (!res.ok) { console.error(`CSS fetch failed for ${fam.q}: ${res.status}`); continue; }
  const css = await res.text();
  // Blocks: /* subset */ @font-face { ... font-weight: NNN; src: url(...) ... }
  const blocks = css.match(/@font-face\s*{[^}]+}/g) || [];
  let saved = 0;
  for (const b of blocks) {
    if (!/U\+0000-00FF/.test(b)) continue; // latin subset only
    const weight = (b.match(/font-weight:\s*(\d+)/) || [])[1];
    const url = (b.match(/url\((https:[^)]+\.woff2)\)/) || [])[1];
    if (!weight || !url) continue;
    const fr = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!fr.ok) { console.error(`font fetch failed ${url}`); continue; }
    const buf = Buffer.from(await fr.arrayBuffer());
    const file = `${fam.prefix}-${weight}.woff2`;
    writeFileSync(resolve(OUT, file), buf);
    console.log(`saved ${file} (${(buf.length / 1024).toFixed(1)} KB)`);
    saved++;
  }
  if (!saved) console.error(`No latin faces saved for ${fam.q}`);
}
console.log('done');
