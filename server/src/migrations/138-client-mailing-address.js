// 138 — Member mailing address columns (Saint SP-256).
//
// ochr_clients had no address fields; office staff could only put an
// address in free-text notes. Additive, nullable TEXT columns. No
// household / family graph (SP-169 stays open — that is a product
// decision, not a column add). No backfill. No PII leave-the-server
// change beyond the existing CLIENT_PUBLIC_COLUMNS allowlist update
// that ships with this migration's callers.

import pool from '../db.js'

export async function up() {
  console.log('Migration 138: client-mailing-address — applying...')

  await pool.query(`
    ALTER TABLE ochr_clients
      ADD COLUMN IF NOT EXISTS mailing_address_line1 TEXT,
      ADD COLUMN IF NOT EXISTS mailing_address_line2 TEXT,
      ADD COLUMN IF NOT EXISTS mailing_city          TEXT,
      ADD COLUMN IF NOT EXISTS mailing_state         TEXT,
      ADD COLUMN IF NOT EXISTS mailing_postal        TEXT
  `)

  console.log('Migration 138: client-mailing-address — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
