// ochr_organizations.kiosk_token
//
// Self-serve kiosk (CHK.7 / Sprint 4). A church can stand a tablet at
// the entrance and let people check themselves in without a staff
// login. The kiosk is reached by a capability URL carrying a per-org
// token (same model as the ICS calendar_token and the swap_token):
// public, unguessable, rotatable.
//
// NULL = kiosk disabled. An admin rotates a token to turn it on and
// can null it back out to revoke. The unique index keeps token → org
// a clean 1:1 lookup.

import pool from '../db.js'

export async function up() {
  console.log('Migration 037: kiosk-token — applying...')

  await pool.query(`
    ALTER TABLE ochr_organizations
      ADD COLUMN IF NOT EXISTS kiosk_token TEXT
  `)

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_organizations_kiosk_token
      ON ochr_organizations (kiosk_token)
     WHERE kiosk_token IS NOT NULL
  `)

  console.log('Migration 037: kiosk-token — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
