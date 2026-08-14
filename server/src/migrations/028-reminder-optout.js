// ochr_clients.reminders_opt_out
//
// Reminders, RM.2 — members have no login, but RM.1 now emails them
// serving reminders. This gives a member a way to opt out: the public
// swap-token page (their existing per-member surface) exposes a toggle
// that flips this column, and the reminder sync skips anyone with it
// set. Default FALSE so existing members keep getting reminders.

import pool from '../db.js'

export async function up() {
  console.log('Migration 028: reminder-optout — applying...')

  await pool.query(`
    ALTER TABLE ochr_clients
      ADD COLUMN IF NOT EXISTS reminders_opt_out BOOLEAN NOT NULL DEFAULT FALSE
  `)

  console.log('Migration 028: reminder-optout — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
