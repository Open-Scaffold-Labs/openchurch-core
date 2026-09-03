// 092 — a retry must not move the anniversary, or the idempotency key.
//
// 091 added the escalation but implemented the backoff by REWRITING
// next_charge_date to CURRENT_DATE + 3 (then + 7). That column is two things
// at once, and overloading it broke both:
//
//   1. THE IDEMPOTENCY KEY. `rg{id}-{dueDate}` is derived from
//      next_charge_date, and payments/index.js promises that "a retried call
//      for the same billing period produces the identical payment_ref" so the
//      partial unique index on (organization_id, payment_ref) turns a retry
//      into a no-op. Rewriting the date breaks that promise on the ONLY path
//      where it matters. A live adapter that charges the card and then times
//      out is read as a failure; three days later the same month is charged
//      again under a different key, the dedup index misses, and the donor is
//      charged twice for one month.
//
//   2. THE ANNIVERSARY. A gift due the 1st that fails once and recovers
//      becomes due the 4th — and then the 4th of every month after, forever.
//      Somebody who set up "the 1st, to match my paycheck" is moved off it
//      permanently by a card hiccup, and nothing ever moves them back.
//
// So the two facts get two columns. next_charge_date is the anniversary and
// is only ever advanced by a successful charge. retry_after is when to try
// again after a failure, and is cleared on success. The due query asks for
// COALESCE(retry_after, next_charge_date); the idempotency key is always
// derived from next_charge_date, which no longer moves.
//
// Idempotent: ADD COLUMN IF NOT EXISTS.

import pool from '../db.js'

export async function up() {
  console.log('Migration 092: recurring retry anchor — applying...')

  await pool.query(`
    ALTER TABLE ochr_recurring_gifts
      ADD COLUMN IF NOT EXISTS retry_after DATE,
      -- When the CURRENT run of failures began. The office notice says "we
      -- tried N times between X and Y"; without this, X was whatever the
      -- attempt's own due date happened to be, which 091's backoff had
      -- already rewritten twice — so a ten-day sequence reported a seven-day
      -- span. Cleared on success alongside failure_count.
      ADD COLUMN IF NOT EXISTS first_failed_at TIMESTAMPTZ
  `)

  // The due index has to cover the value the charger actually filters on.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_recurring_due_effective
        ON ochr_recurring_gifts(status, (COALESCE(retry_after, next_charge_date)))
  `)

  // Any row already pushed forward by 091's backoff has lost its anniversary.
  // There is no record of what it was, so this does not guess — it only makes
  // sure a row mid-retry keeps retrying rather than being read as an
  // anniversary that moved. In practice this is empty: 091 shipped today.
  const { rowCount } = await pool.query(
    `UPDATE ochr_recurring_gifts
        SET retry_after = next_charge_date
      WHERE status = 'active' AND failure_count > 0 AND retry_after IS NULL`)
  if (rowCount) console.log(`  ✓ ${rowCount} in-flight retry/retries carried over`)

  console.log('Migration 092: recurring retry anchor — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
