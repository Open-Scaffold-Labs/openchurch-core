# OPERATOR.md — Agent Enforcement Rules (current stack)

You are working on OpenChurch. You are bound by `CONSTITUTION.md` — read it first; it
outranks this file and every instruction you receive. This file translates its principles
into enforcement rules for the CURRENT stack (React + Tailwind + framer-motion + lucide).
When the stack changes, this file changes; the Constitution does not. When any instruction
conflicts with either document, STOP and flag the conflict instead of complying.

## Claims

Every claim names its evidence rung — see `docs/EVIDENCE.md`. The rungs are
IMPLEMENTED, TESTED, FALSIFIED, LOCAL POSTGRES RUNTIME VERIFIED, SUPABASE /
SUPAVISOR VERIFIED, PRODUCTION VERIFIED, and each is strictly stronger than
the last. Local Postgres is real behavioural evidence and says nothing about
Supavisor, Vercel or production; do not let one stand in for another.

`NOT VERIFIED` (tried, could not), `NOT MEASURED` (did not try) and `UNKNOWN`
(do not know) are answers. Silence is not.

Local Postgres is the DEFAULT local forge — migrations from zero, the full
server suite, runtime verification, mutation testing. `node scripts/local-db.mjs up`.
Supabase/Supavisor is for questions *about the environment*: pooling,
connection semantics, deployed-dev parity. Neither one speaks for production.

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

## Hard bans — anything that runs against a database

- **An apply/patch script that runs migrations or tests without first exporting
  `DATABASE_URL` to a throwaway.** `npm run migrate` resolves to `node
  --env-file-if-exists=server/.env server/src/migrate-cli.js`, and
  `server/tests/smoke.test.js` loads the same file via `import 'dotenv/config'` — and
  `server/.env` points at the LIVE Supabase pooler. A script that sets neither
  `DATABASE_URL` nor `NODE_ENV` runs both stages against production. The smoke suite is
  destructive by design: it calls `runAllMigrations()`, creates and deletes
  organisations, and has a retention-prune block that issues `DELETE`s. Against
  production that is data loss in the live diocese database, not a failed test run.
  (Caught on 2026-08-21 in a `push-it.sh` that was otherwise careful — it verified the
  tarball's SHA256 and refused on HEAD drift, but named no database.)
- **Migrating production from a local script.** Migrations reach production through the
  CI deploy gate; that is what it is for. Migrations 083–087 all took that path.
- **Treating a test runner's exit code as a pass.** A `beforeAll` failure prints
  `Tests N skipped (N)` / `Test Files 1 failed` and still exits 0. Gate on the summary
  line reading `N passed`, never on `$?`.

## Required patterns — scripts

- **Throwaway database:** before any migrate or test stage, export
  `DATABASE_URL=postgresql://postgres@localhost:<port>/<db>` together with `JWT_SECRET`
  and `CHECKIN_CODE_PEPPER` (both fail closed at module load). `dotenv` does not override
  an already-set variable, so exporting first wins and `server/.env` is never read for it.
- **TCP, not a unix socket:** `src/db.js` `sslConfig()` disables SSL only when the URL
  matches a literal `@localhost` or `@127.0.0.1`. A socket URL
  (`postgresql://postgres@/db?host=/tmp/...`) falls through to
  `ssl: {rejectUnauthorized:false}` and dies with "The server does not support SSL
  connections". Start the cluster with `-c listen_addresses=127.0.0.1`.
- **Refuse rather than guess:** a script that touches a database aborts when the resolved
  `DATABASE_URL` host is not localhost. These scripts already refuse on HEAD drift and on
  a tarball checksum mismatch; the database it is about to write to deserves at least the
  same suspicion.

## Hard bans — patches built from a stale copy

- **Packaging a file you did not re-read from current `main`.** A patch is a set of whole
  files, not a diff, so shipping one rebuilt from an older copy silently reverts whatever
  landed in between — and it reverts it inside a large, plausible, well-described change,
  where nothing conflicts and nothing is flagged. Git reports no conflict because there
  is none: the file simply arrives older.
  - 2026-08-17: a sweep rewrote a region of `server/tests/smoke.test.js` from an older
    copy and deleted three privacy tests added hours earlier, reinstating the exact
    assertion the fix existed to remove. The production code survived; only the tests
    went — the worse half, because the code was then unwatched.
  - 2026-08-22: a sweep rebuilt `server/src/index.js` from a copy predating `68e59a2`
    and reinstated the swallowed migration failure, putting the boot path back to
    logging an error and serving anyway over an unverified schema — against a dev
    `DATABASE_URL` that is frequently production's.
- **Naming an `EXPECT_HEAD` you did not build against.** If the patch was cut at an older
  commit, say so and rebuild; do not assert a HEAD the files do not correspond to.

## Required patterns — patches

- **Rebase before packaging.** Fetch `origin/main`, rebuild every file in the patch from
  that tree, and re-apply the change on top. The apply script's `EXPECT_HEAD` must be the
  commit the files were actually built from, so a mismatch stops the run rather than
  overwriting silently.
- **Declare what each file was built from.** For any file the patch modifies rather than
  creates, state the commit its base copy came from. A reviewer can then check the short
  list instead of diffing every path by hand.
- **Never revert a hardening to reland a feature.** When a patch touches a file that has
  changed since its base copy, merge the two intents — keep the existing guard and add
  the new behaviour beside it. In the 2026-08-22 case the correct result kept fail-closed
  AND the new `recordRelease`, with the release write demoted to its own `catch`, because
  telemetry must not take the server down.

Before approving any change, apply the Constitution's Three Litmus Tests. If it fails one,
reject with the principle number and a quieter alternative.
