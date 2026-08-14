// ochr_organizations.timezone
//
// "Today" for a church is a wall-clock notion in that church's own
// timezone, but every date filter in the app leaned on Postgres
// CURRENT_DATE — which is UTC. So a parish on US/Pacific that ran an
// evening service saw it drop off the self-serve kiosk the moment UTC
// rolled past midnight (CHK.7 bug): the event was dated "today" locally
// but `date = CURRENT_DATE` had already advanced to tomorrow.
//
// This adds a per-org IANA timezone (default 'UTC' = the previous
// behavior, so existing orgs are unchanged until they set it). The
// kiosk routes resolve "today" through this column; other CURRENT_DATE
// callers are left as-is for now and can adopt it incrementally.

import pool from '../db.js'

export async function up() {
  console.log('Migration 040: org-timezone — applying...')

  await pool.query(`
    ALTER TABLE ochr_organizations
      ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC'
  `)

  console.log('Migration 040: org-timezone — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
