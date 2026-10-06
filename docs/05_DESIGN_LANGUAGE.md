# Shire Jama LMS — UI/UX Design Language
*"Education Without Limits"* — a design system derived directly from the
institutional seal: a golden open book beneath a rising sun, ringed in deep
forest green. Academic, warm, unmistakably African-scholarly — deliberately
not generic SaaS.

## 1. Design Tokens
| Token | Value | Use |
|---|---|---|
| `--ink-900` | `#122A19` (abyss green) | primary surface (rails, gate panel) |
| `--ink-800` | `#1E3A24` (seal green) | header, active states |
| `--ink-700` | `#2A4D31` | hover fields |
| `--ink-600` | `#3C6B45` | borders on dark |
| `--gold-500` | `#F2A712` (seal gold) | primary accent, CTAs, rings |
| `--gold-600` | `#C77F06` | accent borders |
| `--gold-800` | `#7A5104` | accent text on light (AA) |
| `--paper` | `#FBF9F2` (warm parchment) | app background |
| `--paper-2` | `#F3EFE2` | raised surfaces |
| `--card` | `#FFFFFF` | cards |
| `--line` | `#E4DCC8` | hairlines |
| `--text` | `#1C2A20` · `--muted` `#5C6B5E` | type |
| Semantic | ok `#2F7D46` · warn `#B3540B` · danger `#A3241C` | status |
Dusk theme mirrors the palette onto night reading (deep green-black paper,
gold retained).

## 2. Typography
- **Display:** Oswald (500/600/700) — the condensed capitals of the seal
  lettering; used for headings, portal titles, stat numerals.
- **Text:** Inter (400/500/600/700) — legible humanist sans for UI/body.
- **Mono:** JetBrains Mono (400/600) — institutional codes (`INST-101`,
  `STD-2026-1001`), timers, file sizes.
- Fluid scale via `clamp()`; letterspaced small-caps section labels
  (`--eyebrow`).

## 3. Signature Motifs
- **Sunburst:** radiating ray mask (conic/repeating gradients) on the gate
  panel and empty states — the rising sun of the seal.
- **Double rule:** cards carry a 1px `--line` border + inset 3px gold/green
  keyline (`outline` + `outline-offset`) evoking engraved certificate frames.
- **Weave:** subtle repeating-diagonal background on dark rails (basketry /
  mat pattern honoring the institution's heritage).
- **Seal chip:** circular badges with gold ring for completion/achievement.
- **Progress rings:** `conic-gradient(--gold-500 …)` donut for course completion.

## 4. Layout System
- **Gate:** split screen — left: sunburst panel (logo, motto, Somali proverb
  *“Aqoon la'aan waa iftiin la'aan”* — “Without knowledge there is no light”);
  right: role cards (Student/Teacher/Administrator) then credential form.
- **App shell:** slim top bar (wordmark, breadcrumb, theme toggle, Ctrl+K
  palette, user chip) + collapsible left rail with role sections; parchment
  content field with generous whitespace.
- Density: 8pt rhythm; cards 16px radius; hairline dividers.

## 5. Frontier Interactions
| Technique | Where |
|---|---|
| View Transitions API (progressive) | route changes |
| Command palette (Ctrl+K) | global navigation / quick actions |
| Skeleton loaders + optimistic toggles | all lists, chapter-done |
| Theather mode (native `<dialog>`, full-bleed) | PDF viewer & video player |
| Live countdown pill + local autosave | timed quizzes (reload-safe) |
| Upload progress (XHR `progress` events) | material & answer uploads |
| Toasts + confirm modals (non-blocking) | destructive actions |
| `prefers-reduced-motion` honored | all animation |
| Dusk theme (`:root[data-theme=dusk]`) | reading comfort |

## 6. Portal Information Architecture
- **Administrator:** Overview · Accounts (Teachers/Students/Administrators tabs,
  search + status filters, row actions) · Provision (teacher/student forms with
  generated-code preview) · Backups (config + history console).
- **Teacher:** My Courses (grid + pending-submission badge) → Course Studio
  (chapter timeline; materials & quizzes per chapter; quiz builder with
  question editor) · Submissions (filters, review drawer, scoring, release).
- **Student:** My Learning (course shelf, completion rings) → Course page
  (chapter checklist, material viewers, quiz states) · Quiz runner (focused
  mode, navigator dots, timer, autosave) · My Results (history + breakdown).

## 7. Accessibility Contract
AA contrast on all text (gold is decorative/CTA-fill only; gold-800 on light
for accent text); complete keyboard flows; visible `:focus-visible` rings
(gold 2px offset 2px); ARIA roles on tabs/dialogs/timers; no color-only
status (icons + text); reduced-motion disables transforms/transitions.
