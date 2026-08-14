// Recurrence support on the Schedule (ochr_calendar_events).
//
// Storage shape: every event in a recurring series carries a
// `recurrence_parent_id` pointing at the seed row (the first
// occurrence). The seed itself ALSO points to itself — that way
// the "delete the whole series" query is a single
// `WHERE recurrence_parent_id = $1` no matter which occurrence
// the user clicked. One-off events keep this column NULL.
//
// We rejected RFC 5545 RRULE for v1 — the church use case is
// "every Sunday at 10am for 6 weeks," not arbitrary calendar
// engineering. If we ever need cross-month exceptions ("first
// Sunday of every month except August"), revisit.
//
// ON DELETE CASCADE is set so that if someone manually deletes the
// seed row from the DB (not via our API), the children also go.
// Our API uses scope=series for explicit series deletion and never
// relies on cascade.
//
// Idempotent — IF NOT EXISTS lets re-runs no-op on dev boots.

import pool from '../db.js'

export async function up() {
  console.log('Migration 010: recurrence — applying...')

  await pool.query(`
    ALTER TABLE ochr_calendar_events
      ADD COLUMN IF NOT EXISTS recurrence_parent_id INTEGER
        REFERENCES ochr_calendar_events(id) ON DELETE CASCADE
  `)

  // The hot query is "every event in a series" — given any
  // occurrence's parent_id, find all siblings. Index supports it
  // and stays small because the column is NULL for the vast
  // majority of one-off events.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_ochr_calendar_events_series
      ON ochr_calendar_events(organization_id, recurrence_parent_id)
      WHERE recurrence_parent_id IS NOT NULL
  `)

  console.log('Migration 010: recurrence — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
