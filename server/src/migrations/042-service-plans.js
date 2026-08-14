// Service Planner — order of worship (SVC.1).
//
// A service plan is the run-sheet for a single service: an ordered list
// of elements (entrance hymn, first reading, psalm, gospel, homily,
// offertory, communion, …), each optionally assigned to a person and
// carrying a reference (a scripture citation or a hymn number) and notes.
//
//   ochr_service_plans     — one run-sheet (date + title, optionally
//                            linked to a Schedule event)
//   ochr_service_elements  — the ordered rows within a plan
//
// Tenancy is enforced in the route layer (WHERE organization_id = $1);
// RLS is enabled with no policies as the same blanket backstop every
// ochr_* table carries in prod.

import pool from '../db.js'

export async function up() {
  console.log('Migration 042: service-plans — applying...')

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_service_plans (
      id                 BIGSERIAL PRIMARY KEY,
      organization_id    BIGINT NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      date               DATE NOT NULL,
      title              TEXT NOT NULL DEFAULT 'Service',
      calendar_event_id  BIGINT REFERENCES ochr_calendar_events(id) ON DELETE SET NULL,
      notes              TEXT,
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_service_elements (
      id                  BIGSERIAL PRIMARY KEY,
      organization_id     BIGINT NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      plan_id             BIGINT NOT NULL REFERENCES ochr_service_plans(id) ON DELETE CASCADE,
      position            INTEGER NOT NULL DEFAULT 0,
      kind                TEXT NOT NULL DEFAULT 'other',
      title               TEXT NOT NULL,
      reference           TEXT,
      assigned_client_id  BIGINT REFERENCES ochr_clients(id) ON DELETE SET NULL,
      notes               TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    )
  `)

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_service_plans_org_date ON ochr_service_plans (organization_id, date DESC)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_service_elements_plan ON ochr_service_elements (plan_id, position ASC)`)

  await pool.query(`ALTER TABLE ochr_service_plans ENABLE ROW LEVEL SECURITY`)
  await pool.query(`ALTER TABLE ochr_service_elements ENABLE ROW LEVEL SECURITY`)

  console.log('Migration 042: service-plans — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
