import bcrypt from 'bcryptjs'
import pool from './db.js'

// Every tenant-scoped table picks up the same `organization_id` column
// and index. Defined here so adding a new scoped table is one line.
const TENANT_TABLES = [
  'ochr_clients',
  'ochr_events',
  'ochr_schedule',
  'ochr_tasks',
  'ochr_payroll_staff',
  'ochr_donations',
  'ochr_cash_count_sessions',
  'ochr_notifications',
  'ochr_calendar_events',
  'ochr_ai_generations',
]

// `ochr_event_members`, `ochr_payroll_shifts`, and `ochr_liturgical_calendar` aren't given
// their own org column — they either descend from another tenant row
// (ochr_event_members → ochr_events, ochr_payroll_shifts → ochr_payroll_staff) or live at the
// global/app level (ochr_liturgical_calendar).

// Seed demo creds. DEMO_PASSWORD is read ONLY when SEED_DEMO is true —
// that is, on a local target, or with an explicit SEED_DEMO=true. Setting
// it against a deployed environment does nothing, because seeding does not
// run there. Rotating the credential on a live database is a write to that
// database, not an env change.
const DEMO_EMAIL    = process.env.DEMO_EMAIL    || 'demo@openchurch.app'
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'demo1234'
const DEMO_ORG_SLUG = 'demo-church'

// Whether to seed (and force-restore) the demo org/user.
//
// Seeding creates demo@openchurch.app with a DEFAULT password and
// force-promotes it to admin. On a local database that is a convenience
// the smoke suite and every demo depend on. Anywhere else it is a standing
// admin credential with a publicly known password.
//
// This used to read:
//   NODE_ENV !== 'production' || SEED_DEMO === 'true'
// which made the dangerous direction the DEFAULT. NODE_ENV is unset in a
// laptop shell and unset on a GitHub Actions runner, and both of those
// routinely hold a production DATABASE_URL — `npm run migrate` sets no
// NODE_ENV, and neither did the deploy workflow's migration step. The
// comment above that line correctly stated the intent ("a live deployment
// never re-creates or re-promotes demo@openchurch.app"); the condition did
// not implement it.
//
// CORRECTION (2026-08-26). An earlier version of this comment claimed the
// old guard "had never fired, because the token deploy path had never
// successfully run." That was wrong, and wrong in the direction that
// matters. demo@openchurch.app EXISTS in production — id 1, role admin,
// created 2026-05-13 — so it fired long before any deploy path was
// involved. The deploy job was never the only way to reach a production
// DATABASE_URL: `npm run migrate` from a laptop reaches it, and so does
// the dev server, which runs the migration set on boot against whatever
// server/.env points at.
//
// The lesson is not about this guard. It is that "the mechanism I was
// looking at never ran" is not the same claim as "this never happened",
// and only the second one was worth asserting. Check the database.
//
// This fix stops the account being RE-CREATED or re-promoted. It does
// not remove the one that is already there. That is a separate action
// against production and it is not something a migration should do.
//
// So key the decision on the TARGET rather than on a label. What makes a
// standing admin credential dangerous is WHERE it is being written, and
// that is knowable from the connection string rather than from something
// an operator has to remember to export. Explicit SEED_DEMO=true still
// overrides, because seeding a remote demo environment on purpose is a
// legitimate thing to want.
function targetIsLocal() {
  const raw = process.env.DATABASE_URL || ''
  if (!raw) return true // no target at all; migrations will fail on their own
  try {
    const host = new URL(raw).hostname
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)
  } catch {
    return false // unparseable: assume remote and fail closed
  }
}

const SEED_DEMO =
  process.env.SEED_DEMO === 'true' ||
  (process.env.NODE_ENV !== 'production' && targetIsLocal())

if (!SEED_DEMO && process.env.NODE_ENV !== 'production') {
  console.log('[migrate] remote database detected — skipping demo seed. Set SEED_DEMO=true to override.')
}

export async function migrate() {
  // ── Core auth tables ────────────────────────────────────────
  // Organizations = tenants. One row per church.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_organizations (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      slug       TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // Users = login accounts. Staff-only for v1; every user belongs to
  // exactly one organization and is an admin there.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_users (
      id              SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      email           TEXT UNIQUE NOT NULL,
      password_hash   TEXT NOT NULL,
      name            TEXT NOT NULL,
      role            TEXT NOT NULL DEFAULT 'admin',
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_organization ON ochr_users(organization_id)`)

  // Ensure a Demo Church org exists so existing data has somewhere to go
  // and presentations have a working login. Guarded by SEED_DEMO — in
  // production we don't stand up a demo org unless explicitly opted in.
  if (SEED_DEMO) {
    await pool.query(
      `INSERT INTO ochr_organizations (name, slug) VALUES ($1, $2)
       ON CONFLICT (slug) DO NOTHING`,
      ['Demo Church', DEMO_ORG_SLUG]
    )
  }
  const { rows: orgRows } = await pool.query(
    'SELECT id FROM ochr_organizations WHERE slug = $1',
    [DEMO_ORG_SLUG]
  )
  // May be undefined on a fresh prod DB where SEED_DEMO is off and no demo
  // org was ever created; the backfills below tolerate that (they only
  // touch rows with a NULL organization_id, of which a fresh DB has none).
  const DEMO_ORG_ID = orgRows[0]?.id

  // Ensure demo user exists. We hash the password here rather than baking a
  // fixed hash into the migration so bcrypt's cost factor stays consistent
  // with the rest of the app. Note this runs only when SEED_DEMO is true,
  // so changing DEMO_PASSWORD cannot rotate an account that is already
  // seeded on a remote database. Guarded by SEED_DEMO so production never
  // (re)creates or force-promotes demo@openchurch.app on every boot — a
  // standing admin credential we don't want silently resurrected in prod.
  if (SEED_DEMO) {
    const { rows: existingDemo } = await pool.query(
      'SELECT id, role FROM ochr_users WHERE email = $1',
      [DEMO_EMAIL]
    )
    if (existingDemo.length === 0) {
      const hash = await bcrypt.hash(DEMO_PASSWORD, 10)
      await pool.query(
        `INSERT INTO ochr_users (organization_id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, 'admin')`,
        [DEMO_ORG_ID, DEMO_EMAIL, hash, 'Demo Admin']
      )
      console.log(`Seeded demo user ${DEMO_EMAIL} in '${DEMO_ORG_SLUG}'`)
    } else if (existingDemo[0].role !== 'admin') {
      // Self-heal: if someone demoted demo while testing the Team page
      // (the last-admin guard only protects when there's a single admin,
      // so a 2-admin org allows demoting demo), restore admin on next
      // boot. Demo is the universal fallback for presentations and
      // lockout recovery — it must always be admin.
      await pool.query(
        `UPDATE ochr_users SET role = 'admin' WHERE email = $1`,
        [DEMO_EMAIL]
      )
      console.log(`Restored demo user ${DEMO_EMAIL} to admin (was '${existingDemo[0].role}')`)
    }
  }

  // ── Existing tenant tables ──────────────────────────────────
  // ochr_clients
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_clients (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      company    TEXT,
      email      TEXT,
      phone      TEXT,
      notes      TEXT,
      status     TEXT DEFAULT 'active',
      role       TEXT DEFAULT 'Member',
      tags       TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    ALTER TABLE ochr_clients
      ADD COLUMN IF NOT EXISTS status     TEXT DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS role       TEXT DEFAULT 'Member',
      ADD COLUMN IF NOT EXISTS tags       TEXT,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS calendar_token TEXT UNIQUE
  `)

  // ochr_events
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_events (
      id               SERIAL PRIMARY KEY,
      title            TEXT NOT NULL,
      service_division TEXT,
      date             DATE,
      time             TIME,
      location         TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    ALTER TABLE ochr_events
      ADD COLUMN IF NOT EXISTS liturgical_season TEXT,
      ADD COLUMN IF NOT EXISTS liturgical_color  TEXT,
      ADD COLUMN IF NOT EXISTS feast_name        TEXT
  `)

  // ochr_event_members — links ochr_events to assigned members (ochr_clients).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_event_members (
      event_id   INTEGER NOT NULL REFERENCES ochr_events(id) ON DELETE CASCADE,
      member_id  INTEGER NOT NULL REFERENCES ochr_clients(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (event_id, member_id)
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_event_members_member ON ochr_event_members(member_id)`)

  // ochr_schedule
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_schedule (
      id             SERIAL PRIMARY KEY,
      title          TEXT NOT NULL,
      service_type   TEXT,
      day_of_week    TEXT,
      start_time     TIME,
      end_time       TIME,
      recurrence     TEXT DEFAULT 'Weekly',
      specific_date  DATE,
      location       TEXT,
      notes          TEXT,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // ochr_tasks
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_tasks (
      id             TEXT PRIMARY KEY,
      title          TEXT NOT NULL,
      description    TEXT,
      category       TEXT NOT NULL,
      assigned_to    TEXT,
      priority       TEXT DEFAULT 'MEDIUM',
      status         TEXT DEFAULT 'PENDING',
      recurring_freq TEXT,
      checklist      JSONB DEFAULT '[]',
      due_date       DATE,
      created_at     TIMESTAMPTZ DEFAULT NOW(),
      completed_at   TIMESTAMPTZ
    )
  `)
  await pool.query(`ALTER TABLE ochr_tasks ADD COLUMN IF NOT EXISTS due_date DATE`)
  await pool.query(`ALTER TABLE ochr_tasks ADD COLUMN IF NOT EXISTS assigned_member_id INTEGER REFERENCES ochr_clients(id) ON DELETE SET NULL`)

  // payroll
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_payroll_staff (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      role       TEXT DEFAULT 'Staff',
      pay_rate   NUMERIC(10,2) DEFAULT 0,
      status     TEXT DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_payroll_shifts (
      id         SERIAL PRIMARY KEY,
      staff_id   INTEGER NOT NULL REFERENCES ochr_payroll_staff(id) ON DELETE CASCADE,
      date       DATE NOT NULL,
      hours      NUMERIC(5,2) NOT NULL,
      type       TEXT DEFAULT 'service',
      notes      TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // ochr_donations
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_donations (
      id         SERIAL PRIMARY KEY,
      donor_name TEXT NOT NULL,
      amount     NUMERIC(10,2) NOT NULL,
      category   TEXT DEFAULT 'tithe',
      method     TEXT DEFAULT 'cash',
      date       DATE NOT NULL DEFAULT CURRENT_DATE,
      notes      TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_cash_count_sessions (
      id            SERIAL PRIMARY KEY,
      service_name  TEXT NOT NULL,
      service_date  DATE NOT NULL DEFAULT CURRENT_DATE,
      category      TEXT DEFAULT 'offering',
      counted_by    TEXT NOT NULL,
      verified_by   TEXT,
      denominations JSONB NOT NULL DEFAULT '{}',
      total         NUMERIC(10,2) NOT NULL DEFAULT 0,
      status        TEXT DEFAULT 'pending',
      donation_id   INTEGER REFERENCES ochr_donations(id) ON DELETE SET NULL,
      notes         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // ochr_notifications
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_notifications (
      id         SERIAL PRIMARY KEY,
      member_id  INTEGER REFERENCES ochr_clients(id) ON DELETE CASCADE,
      task_id    TEXT,
      task_title TEXT,
      message    TEXT NOT NULL,
      read       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`
    ALTER TABLE ochr_notifications
      ADD COLUMN IF NOT EXISTS type        TEXT DEFAULT 'task',
      ADD COLUMN IF NOT EXISTS event_id    INTEGER,
      ADD COLUMN IF NOT EXISTS event_title TEXT
  `)
  await pool.query(`UPDATE ochr_notifications SET type = 'task' WHERE type IS NULL`)

  // ochr_calendar_events
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_calendar_events (
      id          SERIAL PRIMARY KEY,
      title       TEXT NOT NULL,
      date        DATE NOT NULL,
      start_time  TIME NOT NULL,
      end_time    TIME NOT NULL,
      type        TEXT DEFAULT 'event',
      assigned_to JSONB DEFAULT '[]',
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  // ochr_liturgical_calendar — global, not tenant-scoped.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_liturgical_calendar (
      id               SERIAL PRIMARY KEY,
      date             DATE UNIQUE,
      season           TEXT,
      feast_name       TEXT,
      liturgical_color TEXT
    )
  `)

  // ochr_ai_generations
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_ai_generations (
      id         SERIAL PRIMARY KEY,
      type       TEXT NOT NULL,
      prompt     TEXT NOT NULL,
      output     TEXT NOT NULL,
      provider   TEXT,
      model      TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ai_generations_created_at ON ochr_ai_generations(created_at DESC)`)

  // ── Tenant scoping ──────────────────────────────────────────
  // For each tenant table: add organization_id (nullable initially), backfill
  // every pre-auth row to the Demo Church, then lock the column to NOT NULL
  // and index it. Idempotent — re-running just re-verifies.
  for (const table of TENANT_TABLES) {
    await pool.query(`
      ALTER TABLE ${table}
        ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES ochr_organizations(id) ON DELETE CASCADE
    `)
    // Backfill legacy pre-auth rows onto the Demo Church. Only runs when a
    // demo org exists (dev/test, or prod with SEED_DEMO). A fresh prod DB
    // with SEED_DEMO off has no NULL-org rows, so skipping this is safe and
    // the SET NOT NULL below still succeeds on the empty table.
    if (DEMO_ORG_ID != null) {
      await pool.query(
        `UPDATE ${table} SET organization_id = $1 WHERE organization_id IS NULL`,
        [DEMO_ORG_ID]
      )
    }
    await pool.query(`ALTER TABLE ${table} ALTER COLUMN organization_id SET NOT NULL`)
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_${table}_organization ON ${table}(organization_id)`
    )
  }

  // Seed default church ochr_tasks if table is empty — now scoped to Demo
  // Church. Skipped when there's no demo org (prod without SEED_DEMO), since
  // the rows have to belong to a real tenant.
  const { rows: existing } = await pool.query('SELECT COUNT(*) FROM ochr_tasks')
  if (DEMO_ORG_ID != null && parseInt(existing[0].count) === 0) {
    const seed = [
      { id: 'open-1',  title: 'Unlock church building',    category: 'OPENING',      priority: 'HIGH',   recurring_freq: 'DAILY',       checklist: ['Unlock all main entrances','Disable alarm system','Check for overnight issues'] },
      { id: 'open-2',  title: 'Facility walkthrough',      category: 'OPENING',      priority: 'HIGH',   recurring_freq: 'DAILY',       checklist: ['Check sanctuary cleanliness','Inspect restrooms','Ensure exits are clear','Check lights and AC'] },
      { id: 'open-3',  title: 'Prepare sanctuary',         category: 'SERVICE_PREP', priority: 'HIGH',   recurring_freq: 'SUNDAY_ONLY', checklist: ['Turn on stage lights','Set up microphones','Place Bibles and bulletins','Test audio system'] },
      { id: 'clean-1', title: 'Daily cleaning',            category: 'CLEANING',     priority: 'MEDIUM', recurring_freq: 'DAILY',       checklist: ['Empty trash bins','Disinfect high-touch areas','Clean restrooms','Vacuum main areas'] },
      { id: 'clean-2', title: 'Sanctuary reset',           category: 'CLEANING',     priority: 'MEDIUM', recurring_freq: 'DAILY',       checklist: ['Straighten chairs/pews','Remove old bulletins','Wipe podium and instruments'] },
      { id: 'ops-1',   title: 'Staff check-in',            category: 'DAILY_OPS',    priority: 'MEDIUM', recurring_freq: 'DAILY',       checklist: ['Confirm volunteers scheduled','Review announcements','Check calendar events'] },
      { id: 'ops-2',   title: 'Respond to communications', category: 'DAILY_OPS',    priority: 'LOW',    recurring_freq: 'DAILY',       checklist: ['Check emails','Respond to prayer requests','Update members if needed'] },
      { id: 'close-1', title: 'End-of-day security check', category: 'CLOSING',      priority: 'HIGH',   recurring_freq: 'DAILY',       checklist: ['Turn off lights','Lock all doors','Activate alarm system'] },
      { id: 'close-2', title: 'Shut down equipment',       category: 'CLOSING',      priority: 'HIGH',   recurring_freq: 'DAILY',       checklist: ['Turn off sound system','Shut down computers','Check thermostats'] },
    ]
    for (const t of seed) {
      await pool.query(
        `INSERT INTO ochr_tasks (id, title, category, priority, recurring_freq, checklist, organization_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [t.id, t.title, t.category, t.priority, t.recurring_freq, JSON.stringify(t.checklist), DEMO_ORG_ID]
      )
    }
  }

  // Demo-org sample seeding lives in runAllMigrations() (see
  // migrations/index.js) so it runs *after* the numbered migrations
  // have added columns the seed depends on (e.g. ochr_clients.birth_date
  // from 011-birthdays). Keeping it here would re-introduce the
  // "column does not exist" race on a fresh database.

  console.log('Migrations complete')
}

// Export the helper so auth.js can create a fresh org on signup.
export { DEMO_ORG_SLUG }
