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
| **AI Studio** | Sermon outlines, devotionals, and announcements, with a per-parish monthly quota. Platform traffic prefers OpenRouter / OpenAI-compat, then Anthropic, then first-party OpenAI. Assistance as craft, not sorcery — bring your own key |
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
the whole reason it is safe to put here.

It ships with a handful of sample members, events, and tasks so the Dashboard isn't empty on first login. The Dashboard also surfaces a "Get started" checklist that auto-checks items as you wire up your workspace (add a real member, set your letterhead, invite a teammate, etc.). Clear the samples from the banner whenever you're ready.

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
- Automatic deploys from `main` are disabled in `vercel.json`; production ships from a deploy pipeline configured outside this repository, and only after the smoke suite and both client builds pass.
- Migrations are **not** run on cold-starts in production. After a deploy that includes schema changes, run `npm run migrate` against the production database.

## Operational

### Environment variables

| Var | Purpose | Required |
|---|---|---|
| `DATABASE_URL` | Postgres connection (Supavisor pooler URL on port 6543 in prod) | yes |
| `JWT_SECRET` | Signing key for auth tokens | yes |
| `CHECKIN_CODE_PEPPER` | HMAC pepper for child pickup codes, hashed at rest | yes |
| `BASE_URL` | Public host, used to build the calendar-sync ICS URLs | recommended |
| `OPENROUTER_API_KEY` | Preferred platform AI (OpenAI-compat via OpenRouter) | one of these |
| `AI_BASE_URL` | OpenAI-compat base URL; defaults to OpenRouter when `OPENROUTER_API_KEY` is set | optional |
| `AI_MODEL` | Model for the OpenAI-compat platform path (default `google/gemini-2.5-flash`) | optional |
| `ANTHROPIC_API_KEY` | Fallback platform AI (first-party Anthropic) | one of these |
| `OPENAI_API_KEY` | Fallback first-party OpenAI, or the key for a custom `AI_BASE_URL` | one of these |
| `CRON_SECRET` | Shared secret on `Authorization: Bearer …` for cron endpoints | required for cron |
| `MONITORING_LEVEL` | `error` / `warn` / `info` / `debug` (default `info`) | optional |
| `BILLING_PRICE_ID_PRO` | Provider-specific price id for Pro checkout | when billing is wired |
| `DEMO_EMAIL` / `DEMO_PASSWORD` | Override the seeded demo creds. Read only when the seed runs — local target, or explicit `SEED_DEMO=true`. Inert on a deployed environment. | local only |
| `PG_POOL_MAX` | Postgres connection pool size (default 5) | optional |

`JWT_SECRET` and `CHECKIN_CODE_PEPPER` both fail closed at module load in production — a
missing value crashes the function rather than falling back to an insecure default.

### Cron schedule (`vercel.json` → `crons`)

| Path | Schedule (UTC) | Purpose |
|---|---|---|
| `/api/cron/drain-notifications` | `*/5 * * * *` | Pick up due rows in `ochr_scheduled_notifications` and dispatch them through `notify()` |
| `/api/cron/enqueue-birthdays` | `0 5 * * *` | Walk every org, enqueue `member_birthday` + `member_anniversary` reminders for tomorrow's matches |
| `/api/cron/retention-prune` | `0 4 * * *` | Daily prune of audit log, notification log, AI usage, and terminal-state scheduled notifications |

Vercel cron passes `Authorization: Bearer ${CRON_SECRET}` on each invocation. The endpoints under `/api/cron/*` accept ONLY this auth (no JWT). The same underlying functions are also reachable via `/api/admin/...` for manual operator pokes from the UI; those paths use the standard admin JWT.

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
