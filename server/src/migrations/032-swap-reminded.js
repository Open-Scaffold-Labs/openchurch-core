// ochr_swap_requests.reminded_at
//
// Reminders, NV.3 — a pending swap request that's been sitting for a few
// days gets ONE nudge to the target member. reminded_at records that the
// nudge went out so the daily cron doesn't re-send. NULL = not yet
// nudged.

import pool from '../db.js'

export async function up() {
  console.log('Migration 032: swap-reminded — applying...')

  await pool.query(`
    ALTER TABLE ochr_swap_requests
      ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ
  `)

  console.log('Migration 032: swap-reminded — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
