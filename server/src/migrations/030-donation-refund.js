// ochr_donations — refund columns
//
// Giving, GIV.6 — an admin can refund/void an online gift. The refund
// runs through the payments stub (no money moves yet) and stamps the
// donation so it's excluded from giving stats and shown as refunded.
//
//   refunded_at — when it was refunded (NULL = active gift).
//   refund_ref  — the provider's refund id (stub today).
//
// Existing rows stay active (refunded_at NULL). Stats queries exclude
// rows where payment_status = 'refunded'.

import pool from '../db.js'

export async function up() {
  console.log('Migration 030: donation-refund — applying...')

  await pool.query(`
    ALTER TABLE ochr_donations
      ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS refund_ref  TEXT
  `)

  console.log('Migration 030: donation-refund — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
