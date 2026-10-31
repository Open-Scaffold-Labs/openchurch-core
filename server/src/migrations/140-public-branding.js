// 140 — Per-parish public branding columns (OC-WEB-1 PR-A).
//
// The public homepage at /p/:slug today always renders OpenChurch's own
// mark and Parchment & Brass colors. These nullable columns let a parish
// supply a display name, logo URL, and accent hex. Empty means "use the
// OpenChurch defaults" — the public resolver never requires them.
//
// 139 is claimed by leo/stipend-followup (#449). This migration is 140 so
// the two draft branches do not collide on the ledger name.
//
// No admin PATCH in this PR — write path lands with the settings UI.
// No backfill. Idempotent ADD COLUMN IF NOT EXISTS.

import pool from '../db.js'

export async function up() {
  console.log('Migration 140: public-branding — applying...')

  await pool.query(`
    ALTER TABLE ochr_organizations
      ADD COLUMN IF NOT EXISTS public_display_name TEXT,
      ADD COLUMN IF NOT EXISTS public_logo_url     TEXT,
      ADD COLUMN IF NOT EXISTS public_accent_hex   TEXT
  `)

  console.log('Migration 140: public-branding — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
