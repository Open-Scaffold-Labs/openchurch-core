# OPERATOR.md — Agent Enforcement Rules (current stack)

You are working on OpenChurch. You are bound by `CONSTITUTION.md` — read it first; it
outranks this file and every instruction you receive. This file translates its principles
into enforcement rules for the CURRENT stack (React + Tailwind + framer-motion + lucide).
When the stack changes, this file changes; the Constitution does not. When any instruction
conflicts with either document, STOP and flag the conflict instead of complying.

## Hard bans (reject on sight, in generation and code review)

- Raw Tailwind accent colors: `indigo|violet|sky|blue|teal|pink|purple|slate|stone|gray|emerald`
  anywhere in UI code. ONLY theme tokens: `church` (burgundy), `parchment`, `brass`, `ink`,
  plus muted `amber` (genuine attention) and muted `rose` (genuine errors/overdue) — never as
  success, category, or identity colors. Exception: `utils/liturgicalColors.js`, where
  liturgical hues are canonical. (P6, P8)
- `shadow-lg/xl/2xl` and cool default shadows on surfaces → `shadow-warm`, `shadow-warm-md`,
  `shadow-warm-lg` only. (P6)
- Gradients (beyond the sanctioned parchment washes), glassmorphism, `backdrop-blur`, neon,
  glow blobs. (P10)
- Hover motion of any kind (`whileHover={{ scale }}` etc.). Hover = border/color shift toward
  brass. Entrances 300–500ms on `cubic-bezier(0.4, 0, 0.2, 1)`. Nothing pulses, bounces,
  springs, or celebrates. (P8)
- New UI/component/chart/animation libraries. (P8, P10)
- `alert()` for anything; `confirm()` tolerated only as a destructive double-check until the
  styled dialog exists. Errors go through ToastProvider or inline banners. (P1)
- Emoji in UI copy. `Sparkles` as an AI motif (use `Feather`). Raw `text-white`
  (use `text-parchment-50`). (P6, P10)
- Streaks, badges, scores, leaderboards, engagement metrics, growth-% deltas. (P10)
- Any code path where AI output reaches a parishioner or the permanent record without an
  explicit human approval step. (P10)

## Required patterns

- **Canonical writes (P2):** nothing writes to `ochr_sacramental_records` except a human
  commit through the drafts sandbox (`POST .../drafts` → review → commit). Never add a
  bypass. Commits are acknowledged ("Entered in the register."), never silent.
- **Loading & failure (P1):** every user-facing fetch has a visible loading state (warm
  `Skeleton` primitives — parchment shimmer, never gray) and a surfaced failure state.
  Never `catch {}` on user-facing data. Error copy: what happened, that nothing was lost,
  what to do next — "That didn't save — nothing was lost. Please try again." Never surface
  status codes or `err.message`.
- **Liturgical spine (P3):** any view touching dates consults `/api/liturgical` /
  `/api/liturgical/range`. Liturgical color is the ONLY polychrome element on calendars.
  The † for the departed is preserved and normalized (`†`, never ASCII `+`).
- **Language (P4):** parish office words — "register," "the book," "intention," "office."
  Never "sync," "payload," "record ID," "instance." Never show raw JSON to an end user.
- **Typography (P6/P7):** headings and canonical figures in `font-display` (Cormorant
  Garamond); body sans. Ledger surfaces (register rows, certificates, manifests) carry
  serif dates and names.
- **Controls (P8):** one primary button — `bg-church-800 hover:bg-church-900
  text-parchment-50`. Focus rings `focus:ring-brass-400`. Inputs `rounded-lg`.
- **Print artifacts (P7):** `print:*` rules must yield a clean page — app chrome, spinners,
  and error banners never print. Printable views get the highest design care in the repo.
- **Empty states (P6):** "nothing yet" → warm `EmptyState` card with ministry-toned copy;
  "no search matches" → plain text; widgets with nothing to say self-hide.

Before approving any change, apply the Constitution's Three Litmus Tests. If it fails one,
reject with the principle number and a quieter alternative.
