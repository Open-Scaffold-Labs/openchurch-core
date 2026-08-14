// Performance indexes (H.1 / Sprint 3 hardening)
//
// The hot read paths added across this arc all filter by
// (organization_id, date): the Donations summary/chart/by-fund queries,
// the Schedule's per-week event load, the reminder sync, and the weekly
// digest. None of those had a composite (org, date) index — they fell
// back to the org-only index plus a filter. These two close that gap.
//
// IF NOT EXISTS keeps this idempotent and safe on every dev-boot.

import pool from '../db.js'

export async function up() {
  console.log('Migration 033: perf-indexes — applying...')

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ochr_donations_org_date ON ochr_donations(organization_id, date)`)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_calendar_events_org_date ON ochr_calendar_events(organization_id, date)`)

  console.log('Migration 033: perf-indexes — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
