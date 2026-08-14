// ochr_scheduled_notifications — source linkage
//
// Reminders, RM.1 — to schedule serving reminders for Schedule
// assignments, we need to RE-SYNC a calendar event's reminders when its
// roster changes and CANCEL them when it's deleted. That requires
// knowing which queued rows belong to which event, so this adds a
// (source_type, source_id) back-reference.
//
//   source_type — e.g. 'calendar_event'. Null for the existing
//                 ad-hoc / birthday rows, which don't get re-synced.
//   source_id   — the originating row's id (no FK: the queue outlives
//                 its source, and we cancel explicitly).
//
// Indexed by (source_type, source_id) for the per-event delete the
// sync does on every roster change.

import pool from '../db.js'

export async function up() {
  console.log('Migration 027: reminder-source — applying...')

  await pool.query(`
    ALTER TABLE ochr_scheduled_notifications
      ADD COLUMN IF NOT EXISTS source_type TEXT,
      ADD COLUMN IF NOT EXISTS source_id   INTEGER
  `)

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sched_notif_source ON ochr_scheduled_notifications(source_type, source_id)`)

  console.log('Migration 027: reminder-source — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
