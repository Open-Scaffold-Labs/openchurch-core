// ochr_calendar_events.group_id
//
// Anchor 4 / A4.3 — link a calendar event to a group. Nullable +
// ON DELETE SET NULL: deleting a group leaves its events on the
// schedule (just un-grouped) rather than cascading them away — the
// service still happened, only the organizing group went away.
//
// Split out from 021 (which built the group tables) so the Groups
// backend could ship and bake on its own before the schedule wire
// depended on it.

import pool from '../db.js'

export async function up() {
  console.log('Migration 022: event-groups — applying...')

  await pool.query(`
    ALTER TABLE ochr_calendar_events
      ADD COLUMN IF NOT EXISTS group_id BIGINT
        REFERENCES ochr_groups(id) ON DELETE SET NULL
  `)

  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_calendar_events_group ON ochr_calendar_events(group_id)`
  )

  console.log('Migration 022: event-groups — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
