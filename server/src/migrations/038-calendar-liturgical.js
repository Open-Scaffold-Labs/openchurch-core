// ochr_calendar_events.liturgical_season / liturgical_color / feast_name
//
// Church context (Sprint 2 / LIT.1). The Schedule already *shows* the
// liturgical day per event (computed client-side from /api/liturgical),
// but it was never stored on the row. That left the active schedule
// blind to its own liturgical context everywhere the UI isn't looking:
// serving reminders, the public events feed, check-in, the kiosk.
//
// These columns make liturgical context a first-class property of a
// calendar event. They're auto-mapped at create/update time in
// routes/calendar.js (override table → Easter-algorithm fallback), the
// same pattern the legacy ochr_events table already uses. Nullable so
// existing rows and non-dated edits stay valid.

import pool from '../db.js'

export async function up() {
  console.log('Migration 038: calendar-liturgical — applying...')

  await pool.query(`
    ALTER TABLE ochr_calendar_events
      ADD COLUMN IF NOT EXISTS liturgical_season TEXT,
      ADD COLUMN IF NOT EXISTS liturgical_color  TEXT,
      ADD COLUMN IF NOT EXISTS feast_name        TEXT
  `)

  console.log('Migration 038: calendar-liturgical — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
