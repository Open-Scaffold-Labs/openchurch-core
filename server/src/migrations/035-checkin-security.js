// ochr_checkins.security_code
//
// Check-in, CHK.3 — kid-pickup security. When a child checks in the
// server generates a short one-time code, shown once on the check-in
// screen (for a tag / the guardian). Checking a child out then REQUIRES
// that code, so a child can only be released to whoever holds it. NULL
// for members/guests, who check out freely.

import pool from '../db.js'

export async function up() {
  console.log('Migration 035: checkin-security — applying...')

  await pool.query(`
    ALTER TABLE ochr_checkins
      ADD COLUMN IF NOT EXISTS security_code TEXT
  `)

  console.log('Migration 035: checkin-security — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
