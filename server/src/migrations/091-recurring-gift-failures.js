// 091 — a recurring gift that fails has to be able to say so.
//
// A donor's card expires. The monthly gift fails. Today the charger catches
// the error, logs a monitor line, leaves next_charge_date untouched and
// status 'active' — so the row is due forever, retried every run, silently,
// with no counter, no backoff and nobody told. The donor believes they are
// giving monthly. The parish believes it has the income. Neither is true, and
// nothing in the product surfaces the gap.
//
// The escalation Jose chose (24 Aug): the DONOR hears first and privately,
// and only if it keeps failing does it reach the parish office. Somebody
// whose card was momentarily declined at the bank gets to fix it without the
// secretary ever learning; somebody who has genuinely stopped giving becomes
// a conversation a person can have, rather than a number that quietly drifts.
//
// So the table needs three facts it did not carry:
//   failure_count   how many consecutive attempts have failed
//   last_error      what the provider said, for the office to act on
//   last_failed_at  when, so "still failing" is answerable
//
// …and one new state. 'paused' is NOT 'cancelled': cancelled is the donor's
// decision and ends the gift; paused is the system saying "I have stopped
// trying and somebody should look." Conflating them would tell a parish that
// a giver had left when their card had simply expired.

import pool from '../db.js'

export async function up() {
  console.log('Migration 091: recurring gift failures — applying...')

  await pool.query(`
    ALTER TABLE ochr_recurring_gifts
      ADD COLUMN IF NOT EXISTS failure_count  INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_error     TEXT,
      ADD COLUMN IF NOT EXISTS last_failed_at TIMESTAMPTZ
  `)

  // The status CHECK is a named constraint from 031 and forbids 'paused'.
  // Drop and re-add WIDER — this only ever admits values the old constraint
  // already admitted, plus one, so no existing row can be invalidated.
  await pool.query(`
    ALTER TABLE ochr_recurring_gifts
      DROP CONSTRAINT IF EXISTS ochr_recurring_gifts_status_check
  `)
  await pool.query(`
    ALTER TABLE ochr_recurring_gifts
      ADD CONSTRAINT ochr_recurring_gifts_status_check
      CHECK (status IN ('active', 'cancelled', 'paused'))
  `)

  // The office's list is "what needs attention", which is paused gifts. It is
  // read per-org and ordered by when it stopped.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_recurring_attention
        ON ochr_recurring_gifts(organization_id, status, last_failed_at DESC)
  `)

  // Prove the state actually landed rather than trusting that the statement
  // ran. A CHECK that silently kept its old definition would make every
  // pause throw at 3am inside a cron, which is the worst place to find out.
  const probe = await pool.connect()
  try {
    await probe.query('BEGIN')
    const { rows: [org] } = await probe.query(
      `INSERT INTO ochr_organizations (name, slug)
       VALUES ('__mig091_probe', '__mig091_probe') RETURNING id`)
    await probe.query(
      `INSERT INTO ochr_recurring_gifts
         (organization_id, donor_name, amount, frequency, status, next_charge_date, failure_count)
       VALUES ($1, 'probe', 1, 'monthly', 'paused', CURRENT_DATE, 3)`,
      [org.id])
    await probe.query('ROLLBACK')          // never keep the probe row
  } catch (err) {
    await probe.query('ROLLBACK').catch(() => {})
    throw new Error(`091: 'paused' is not an accepted status — ${err.message}`)
  } finally {
    probe.release()
  }

  console.log('Migration 091: recurring gift failures — applied.')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  up()
    .then(() => { console.log('Done.'); process.exit(0) })
    .catch((err) => { console.error('Migration failed:', err); process.exit(1) })
}
