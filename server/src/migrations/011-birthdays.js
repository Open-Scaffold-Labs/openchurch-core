// Member life-event dates. birth_date powers the daily birthday
// reminder; joined_date powers membership-anniversary reminders.
// Both nullable — existing rows don't have them, and many churches
// don't track birthdays for everyone (privacy, lack of data).
//
// No indexes for v1. The daily lookup is "members in this org with
// birth_date matching tomorrow's M/D"; at OpenChurch scale (1–50
// churches × ~hundreds of members), a full table scan once a day
// is sub-millisecond. If we ever cross into thousands-of-members
// territory we can add an expression index on
// (organization_id, EXTRACT(MONTH FROM birth_date), EXTRACT(DAY FROM birth_date)).
//
// Idempotent — IF NOT EXISTS lets re-runs no-op on dev boots.

import pool from '../db.js'

export async function up() {
  console.log('Migration 011: birthdays — applying...')

  await pool.query(`
    ALTER TABLE ochr_clients
      ADD COLUMN IF NOT EXISTS birth_date  DATE,
      ADD COLUMN IF NOT EXISTS joined_date DATE
  `)

  console.log('Migration 011: birthdays — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
