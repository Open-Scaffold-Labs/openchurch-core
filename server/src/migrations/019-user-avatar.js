// Profile avatars (UI freshen-up). Adds an `avatar` column to BOTH
// people tables:
//   - ochr_users   — login accounts (admin / staff / viewer); each
//                    user edits their own from Preferences.
//   - ochr_clients — members / parishioners; an admin sets theirs
//                    from the member edit modal.
//
// Why base64-in-column rather than object storage: at the project's
// 1–50 church scale the row bloat is negligible — the client resizes
// every upload to a 256px square JPEG before sending (~30–50 KB of
// base64). Postgres TOASTs a TEXT value that size out-of-line and
// compresses it, so the common columns on these tables stay fast. It
// also keeps avatar storage vendor-neutral: no S3 / Supabase Storage
// bucket to provision. If avatars ever need to scale, the swap is to
// write the image to object storage and keep the URL in this same
// column — no schema change.
//
// NULL = no avatar uploaded; the UI falls back to the initials circle
// it already renders.

import pool from '../db.js'

export async function up() {
  console.log('Migration 019: profile avatars — applying...')

  await pool.query(`
    ALTER TABLE ochr_users
      ADD COLUMN IF NOT EXISTS avatar TEXT
  `)

  await pool.query(`
    ALTER TABLE ochr_clients
      ADD COLUMN IF NOT EXISTS avatar TEXT
  `)

  console.log('Migration 019: profile avatars — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
