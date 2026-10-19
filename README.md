## OpenChurch

![Node](https://img.shields.io/badge/node-22.x-43853d?logo=node.js&logoColor=white)

**The parish office, kept well.**

OpenChurch is software for the daily work of a liturgical parish: planning worship, tending
the liturgical calendar, knowing the members by name, recording the parish's giving, and
keeping the sacramental register — baptisms, confirmations, and marriages — the way a
leather-bound book would keep them, only easier to search and impossible to lose.

It is built for the person who actually runs a parish office. Not the rector who signs, but
the administrator who knows what a baptism certificate costs to reissue and which acolyte is
on next Sunday.

It rests on a few convictions:

- **A sacramental record is a century-old document, not a database row.** The register is a
  quasi-legal instrument. It is treated like one.
- **The parish secretary's Tuesday matters as much as Sunday morning.** Most church software
  is built for the weekend service. This is built for the week around it.
- **The register belongs to the parish, not to us.** Every record exports completely, any
  time, in a format you can read without this software.
- **Nothing blinks, counts, or competes for attention.** No streaks, no engagement metrics,
  no badges. Like a well-kept book, it waits until it is needed.

Serving Catholic, Anglican, and Lutheran parishes.

---

### What it does

| Area | |
|---|---|
| **Sacramental register** | Baptisms, confirmations, marriages, first communions, and more — per-book certificate numbering, godparents and sponsors, printable certificates, and an anniversary view that surfaces "twenty years ago this Sunday" |
| **Liturgical calendar** | Seasons, feasts, and colors baked in. Today's liturgical day on the dashboard; season, color, and feast auto-fill onto new events. Liturgical color carries through event rows, schedule tiles, and member profiles |
| **Worship planning** | Service plans, the Sunday Packet with lectionary resolution, the sacristy sheet, and a rota with soft conflict detection when assignees overlap |
| **Members** | The parish roll with CSV import, full-text search, per-member profiles, and birthday / feast-day tracking |
| **Scheduling** | Events and services with member assignment, weekly recurrence, edit-this-and-following on series, and a mobile day list |
| **Giving** | Donations and cash-count sessions, year-end giving statements, and per-donor printable IRS-compliant receipts |
| **Child check-in** | Check children in and out against a pickup code, with printed name tags and a self-serve kiosk mode for a tablet at the entrance |
| **Calendar sync** | A personal ICS feed per member covering every event, schedule entry, and task assigned to them. One-tap subscribe from Apple or Google Calendar |
| **Bulletins & public pages** | A public parish page, bulletin, events list, and giving link, each publishable on its own |
| **AI Studio** | Sermon outlines, devotionals, and announcements, with a per-parish monthly quota and an Anthropic → OpenAI fallback. Assistance as craft, not sorcery — bring your own key |
| **Audit log** | Every mutation captured with actor, entity, summary, and status. Admin-only viewer with filters and pagination |
| **Operations** | Daily task checklists, payroll and shift logging, team roles with last-admin protection, and per-parish insights |

Bilingual throughout (English and Spanish), light and dark, and installable as a PWA.

---

## Getting Started

### Prerequisites

- **Node.js 22**
- A **Supabase project** for the Postgres database. OpenChurch is a Scaffold Labs app and uses the shared OpenScaffold Supabase instance in production; for local dev any Supabase project will do.

### First-time setup

```bash
git clone https://github.com/Open-Scaffold-Labs/OpenChurch.git
cd OpenChurch
npm run install:all        # installs root + client + server deps

# Configure the server
cp server/.env.example server/.env
# Fill in DATABASE_URL (Supabase transaction pooler, port 6543) and JWT_SECRET

# Create tables and seed the demo org
npm run migrate
```

### Running locally

Open two terminals:

```bash
# Terminal 1 — API server on :3034
cd server && npm run dev

# Terminal 2 — Client on :5202
cd client && npm run dev
```

Then visit http://localhost:5202.

### Demo credentials — local only

A demo organization is seeded on first migration so you don't have to sign up just to look around:

- **Email:** `demo@openchurch.app`
- **Password:** `demo1234`

**These are local development credentials and nothing else.** The seed runs
only against a local target (or with an explicit `SEED_DEMO=true`), so a
deployed environment neither creates this account nor honours this password.
Do not treat the pair above as a way into any running deployment, and do not
reuse it as a starting point for one — it is published in this file, which is
the whole reason it is safe to put here. Do not set `SEED_DEMO=true` against
production to provision App Store reviewers.

The Login page does **not** advertise or auto-fill this pair. A one-click
"Use demo account" helper exists only for local Vite development when
`VITE_ENABLE_DEMO_LOGIN=true` is set (see `client/.env.example`). Production
builds compile `import.meta.env.DEV` to false and drop the helper — the
password is not in the production client bundle. Never set
`VITE_ENABLE_DEMO_LOGIN` in `client/.env.production` or a production deploy.

It ships with a handful of sample members, events, and tasks so the Dashboard isn't empty on first login. The Dashboard also surfaces a "Get started" checklist that auto-checks items as you wire up your workspace (add a real member, set your letterhead, invite a teammate, etc.). Clear the samples from the banner whenever you're ready.

App Store review uses a **separate non-prod tenant**, not this pair and not
production `demo@`. Credentials come from environment variables and go in
App Store Connect Review Notes only — never in the client. See
[docs/APP-REVIEW-TENANT.md](docs/APP-REVIEW-TENANT.md).

### Before you push

Every push to a pull request runs the full CI gate (about ten billed minutes). Run the cheap
checks locally first and push each change set once, green:

```bash
npm run check:prepush               # changes vs origin/main; --base <ref> for another base
```

It always runs the honest-failure, OPERATOR and API-shape lints and the CI scope
regressions, then the client, chancery and server tests *related to the files you changed*.
Server tests run only against a loopback `DATABASE_URL` (`node scripts/local-db.mjs up`,
then `eval "$(node scripts/local-db.mjs env)"`); otherwise that step prints `NOT RUN`, which
is not a pass. It is not a git hook and not a substitute for CI: no builds and no full suites.

### Running the tests

The suite needs a real Postgres — it builds the schema through the migration ledger and then
runs against it. Point it at a throwaway database, never your production one:

```bash
cd server
DATABASE_URL='postgres://postgres@localhost:5432/openchurch_test' \
JWT_SECRET='test-secret' \
CHECKIN_CODE_PEPPER='test-pepper' \
NODE_ENV=test npm test
```

Parish client tests are jsdom and need no database. Golden Journey 1
(book → sacristy sheet → print) and Golden Journey 2 (member → linked
register → certificate → print) share one entry point. It runs both,
labels each journey, and fails if either is not green:

```bash
cd client && npm run test:golden
```

A fail-closed rehearsal command runs that pair plus the GJ2 certificate-path
file, and refuses `--local-db` unless the environment is a loopback forge.
It never seeds or follows `server/.env`. See `docs/DEMO-REHEARSAL.md`.

```bash
npm run rehearsal:proof
```

Each journey still runs on its own:

```bash
cd client && npm test -- src/pages/GoldenJourney1.test.jsx
cd client && npm test -- src/pages/GoldenJourney2.test.jsx
```

## Project Structure

```
openchurch/
├── api/                  # Vercel serverless entry — re-exports server/src/app.js
├── client/               # React 19 + Vite + Tailwind SPA
│   └── src/
│       ├── pages/        # Route-level components (Dashboard, Clients, Events, ...)
│       ├── components/   # Shared UI (EmptyState, ImportMembersModal, ...)
│       ├── context/      # AuthContext, ThemeContext
│       └── auth/         # Fetch interceptor + token storage
├── client-diocese/       # The chancery app — its own Vercel project
├── server/               # Express API
│   └── src/
│       ├── app.js        # Express app factory (no .listen call)
│       ├── index.js      # Local-dev entry; listens on :3034
│       ├── routes/       # /api/* handlers, one file per resource
│       ├── middleware/   # requireAuth (JWT validation)
│       ├── migrate.js    # Schema migrations + demo seed
│       ├── migrations/   # Versioned schema changes (001-bilingual, ...)
│       ├── onboarding/   # Sample-data seeding for new orgs
│       └── utils/        # CSV parser, param validators
├── docs/                 # Architecture, brand, philosophy, operations
├── vercel.json           # Root build config (client + api routing)
└── package.json          # Root deps (mirrors server so Vercel can bundle)
```

## Architecture

- **Frontend:** React 19, Vite, Tailwind v3.4. Routing via `react-router-dom` v7, animation via `framer-motion`, icons via `lucide-react`.
- **Backend:** Express 4 on Node 22. In production it deploys to Vercel as a single serverless function via `api/index.js`.
- **Database:** Postgres (Supabase). Connections go through the Supavisor transaction-mode pooler on port 6543 — direct connections from serverless functions exhaust Postgres' `max_connections` almost immediately under real load.
- **Read caching:** Read-heavy GETs (`/api/audit-log`, `/api/liturgical[/range]`, `/api/calendar/conflicts`, `/api/giving-statements/*`, `/api/insights`, `/api/organization`, `/api/clients/:id/donations`) ship `Cache-Control: private, max-age=N` headers tuned per data shape. Browser does the heavy lifting; no shared cache infrastructure needed.
- **Auth:** Native email + password with `bcryptjs` hashing, JWTs in `localStorage` under the key `ochr_token`, 7-day expiry. `/api/auth/signup` creates an organization and its first admin user atomically.
- **Multi-tenancy:** Every OpenChurch-owned table carries an `organization_id` FK. Every query filters by `req.organizationId` (derived from the JWT). Cross-tenant leakage is prevented at the query layer.
- **Bilingual:** A `language` column on user-facing entities plus a dedicated `ochr_translations` side table holds parallel English / Spanish content. See `server/src/migrations/001-bilingual.js` for the canonical shape.

## Scaffold Labs Conventions

OpenChurch is part of the Open Scaffold Labs ecosystem and ships alongside other apps on a shared Supabase + Vercel platform. These four values are fixed by that ecosystem, and are checked on every push upstream:

| Convention | Value | Why |
|---|---|---|
| Client port | `5202` | The registry expects it |
| Server port | `3034` | The registry expects it |
| Auth localStorage key | `ochr_token` | Namespace-safe across ecosystem apps |
| DB table prefix | `ochr_` | OpenChurch tables coexist with the Hub's `lsh_` tables in the shared Supabase instance |

## Deployment

OpenChurch deploys as a Vercel monorepo:

- Root `vercel.json` builds the client to `client/dist` and routes `/api/*` into `api/index.js`.
- Set the env vars listed in [Operational](#operational) below in the Vercel project.
- Automatic deploys from `main` are disabled in `vercel.json`. Production ships from a deploy pipeline configured outside this repository, and only after the smoke suite and both client builds pass. Tip on `main` is **not** proof of what production is serving; check `/api/health`.
- Migrations are **not** run on cold-starts in production. After a deploy that includes schema changes, run `npm run migrate` against the production database.

## Operational

### Environment variables

| Var | Purpose | Required |
|---|---|---|
| `DATABASE_URL` | Postgres connection (Supavisor pooler URL on port 6543 in prod) | yes |
| `JWT_SECRET` | Signing key for auth tokens | yes |
| `CHECKIN_CODE_PEPPER` | HMAC pepper for child pickup codes, hashed at rest | yes |
| `BASE_URL` | Public host, used to build the calendar-sync ICS URLs | recommended |
| `ANTHROPIC_API_KEY` | Primary AI provider | one of these |
| `OPENAI_API_KEY` | Fallback AI provider | one of these |
| `CRON_SECRET` | Shared secret on `Authorization: Bearer …` for cron endpoints | required for cron |
| `MONITORING_LEVEL` | `error` / `warn` / `info` / `debug` (default `info`) | optional |
| `BILLING_PRICE_ID_PRO` | Provider-specific price id for Pro checkout | when billing is wired |
| `DEMO_EMAIL` / `DEMO_PASSWORD` | Override the seeded demo creds. Read only when the seed runs — local target, or explicit `SEED_DEMO=true`. Inert on a deployed environment. Do not use to provision App Review. | local only |
| `SEED_APP_REVIEW_TENANT` | When `1`/`true`, seed a throwaway App Review org+user on a **non-prod** host from `APP_REVIEW_*` env vars. Refused in production. See [docs/APP-REVIEW-TENANT.md](docs/APP-REVIEW-TENANT.md). | review host only |
| `APP_REVIEW_EMAIL` / `APP_REVIEW_PASSWORD` / `APP_REVIEW_ORG_NAME` | Review-tenant credentials and org name. No defaults; never compiled into the client. Optional: `APP_REVIEW_ORG_SLUG`, `APP_REVIEW_USER_NAME`, `APP_REVIEW_ALLOW_REMOTE`. | review host only |
| `VITE_ENABLE_DEMO_LOGIN` | Client / Vite only. When `true` **and** `import.meta.env.DEV`, Login shows a local demo-account helper. Must stay unset in production builds (`client/.env.production`). | local only |
| `PG_POOL_MAX` | Postgres connection pool size (default 5) | optional |

`JWT_SECRET` and `CHECKIN_CODE_PEPPER` both fail closed at module load in production — a
missing value crashes the function rather than falling back to an insecure default.

### Cron schedule (`vercel.json` → `crons`)

Eight entries are declared in `vercel.json`:

| Path | Schedule (UTC) | Purpose |
|---|---|---|
| `/api/cron/drain-notifications` | `*/5 * * * *` | Pick up due rows in `ochr_scheduled_notifications` and dispatch them through `notify()` |
| `/api/cron/enqueue-birthdays` | `0 5 * * *` | Walk every org, enqueue `member_birthday` + `member_anniversary` reminders for tomorrow's matches |
| `/api/cron/retention-prune` | `0 4 * * *` | Daily prune of audit log, notification log, AI usage, and terminal-state scheduled notifications |
| `/api/cron/enqueue-sacrament-anniversaries` | `0 6 * * 1` | Weekly sacrament-anniversary digest enqueue per org |
| `/api/cron/backup-digest` | `0 8 * * 6` | Weekly off-site backup digest |
| `/api/cron/charge-recurring` | `0 9 * * *` | Charge due recurring gifts (stub-safe when payments are unconfigured) |
| `/api/cron/nudge-swaps` | `0 16 * * *` | Nudge stale pending schedule-swap requests |
| `/api/cron/weekly-serving-digest` | `0 15 * * 4` | Weekly serving digest per assignee |

Vercel cron passes `Authorization: Bearer ${CRON_SECRET}` on each invocation. The endpoints under `/api/cron/*` accept ONLY this auth (no JWT). Three of these also have `/api/admin/...` manual-poke counterparts (drain, enqueue-birthdays, retention-prune); the other five are cron-only today.

### Vendor-neutral integrations

Three subsystems are designed to swap providers in a single file when team picks land:

| Subsystem | Stub today | Real swap point |
|---|---|---|
| Email transport | Logs every dispatch to `ochr_notification_log` with status `'stubbed'` | `dispatchStub` in `server/src/notifications/transport.js` |
| Error monitoring | Structured JSON to stderr/stdout | `dispatch` in `server/src/monitoring/index.js` |
| Billing provider | Vendor-neutral schema columns (`provider_customer_id`, `provider_subscription_id`) + stub flow | `server/src/routes/billing.js` once the provider is picked |

## Development Team

OpenChurch is developed in partnership with **Scaffold Labs** — a software development team dedicated to building modern, scalable applications.

**Scaffold Labs Contributors:**
- Dale Raaen (draaen-jpg)
- jwolfer73
- mlav1114
- tracynoelle

For questions or contributions, please reach out through the repository's Issues or Pull Requests.
