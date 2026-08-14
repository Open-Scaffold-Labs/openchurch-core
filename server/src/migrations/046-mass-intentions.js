// ochr_mass_intentions (MI.1) — the Mass intention book.
//
// A Catholic-parish staple that generic ChMS tools don't model: a request to
// offer a Mass for a particular intention (often a deceased person, marked
// "+Name" by convention, or a special intention), usually with an offering
// (stipend). Parishes keep a book of these and schedule them onto Masses.
//
//   intention   — free text ("+John Smith", "For the Rivera family").
//   requested_by / requested_by_client_id — who asked; optional member link
//                 (ON DELETE SET NULL so removing a member keeps the record;
//                 same-org validation is enforced in the route).
//   mass_date   — the day it's to be offered (nullable until scheduled).
//   calendar_event_id — optional link to the scheduled Mass (SET NULL).
//   stipend     — offering amount, NUMERIC(10,2) like all money here.
//   status      — open | scheduled | fulfilled | cancelled (CHECK, so the
//                 set can grow with a constraint replace, not a type change).

import pool from '../db.js'

export async function up() {
  console.log('Migration 046: mass-intentions — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_mass_intentions (
      id                     BIGSERIAL PRIMARY KEY,
      organization_id        INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      intention              TEXT NOT NULL,
      requested_by           TEXT,
      requested_by_client_id INTEGER REFERENCES ochr_clients(id) ON DELETE SET NULL,
      mass_date              DATE,
      calendar_event_id      INTEGER REFERENCES ochr_calendar_events(id) ON DELETE SET NULL,
      stipend                NUMERIC(10,2) CHECK (stipend IS NULL OR stipend >= 0),
      status                 TEXT NOT NULL DEFAULT 'open'
                               CHECK (status IN ('open', 'scheduled', 'fulfilled', 'cancelled')),
      note                   TEXT,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // The book view (org + status), and the "what's on the calendar" view
  // (org + date).
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mass_intentions_org_status ON ochr_mass_intentions(organization_id, status)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mass_intentions_org_date   ON ochr_mass_intentions(organization_id, mass_date)`)

  // RLS enabled with no policy — the ochr_* invariant (tenancy enforced in
  // the route layer; advisors flag rls_disabled_in_public otherwise).
  await pool.query(`ALTER TABLE ochr_mass_intentions ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 046: mass-intentions — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
