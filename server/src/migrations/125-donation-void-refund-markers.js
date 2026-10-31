// 125 — who recorded a donation void or refund marker.
//
// ADDITIVE ONLY. Three nullable columns on ochr_donation_refunds, one
// tenant-composite FK, one partial unique index, one CHECK on the new
// column. No donation row is rewritten and no refund row is backfilled.
//
//   recorded_by_user_id / recorded_by_name — the staff member who posted
//     the reversing fact, and a name snapshot that survives user deletion.
//     Cash-count voids (123) already store who on the count; the fact
//     itself can now say the same.
//   idempotency_key — the caller's token for one attempt. The same token
//     is one fact. A second insert with that token is refused here even
//     if a route forgets its lock. NULL stays allowed: provider refunds
//     and cash-count voids do not carry one, and many NULLs are not a
//     duplicate.
//
// kind and the one-void unique index already exist (123). The 104 cap
// trigger still refuses a reversal whose sum would pass the gift. This
// migration does not replace either.

import pool from '../db.js'

export async function up() {
  console.log('Migration 125: donation-void-refund-markers — applying...')

  await pool.query(`
    ALTER TABLE ochr_donation_refunds
      ADD COLUMN IF NOT EXISTS recorded_by_user_id INTEGER,
      ADD COLUMN IF NOT EXISTS recorded_by_name    TEXT,
      ADD COLUMN IF NOT EXISTS idempotency_key     TEXT
  `)

  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_donation_refunds_recorded_by_fk') THEN
        ALTER TABLE ochr_donation_refunds ADD CONSTRAINT ochr_donation_refunds_recorded_by_fk
          FOREIGN KEY (recorded_by_user_id, organization_id)
          REFERENCES ochr_users (id, organization_id)
          ON DELETE SET NULL (recorded_by_user_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_donation_refunds_idem_len') THEN
        ALTER TABLE ochr_donation_refunds ADD CONSTRAINT ochr_donation_refunds_idem_len
          CHECK (idempotency_key IS NULL OR (length(idempotency_key) > 0 AND length(idempotency_key) <= 120));
      END IF;
    END $$
  `)

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_donation_refunds_idempotency
      ON ochr_donation_refunds (organization_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
  `)

  const { rows: cols } = await pool.query(`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'ochr_donation_refunds'
       AND column_name IN ('recorded_by_user_id', 'recorded_by_name', 'idempotency_key')
  `)
  if (cols.length !== 3) {
    throw new Error('125: recorded-by / idempotency columns did not land')
  }

  const { rows: fk } = await pool.query(`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname = 'ochr_donation_refunds_recorded_by_fk'
  `)
  if (!fk.length || !/organization_id/.test(fk[0].def) || !/ochr_users/.test(fk[0].def)) {
    throw new Error('125: recorded-by FK is not a tenant composite onto ochr_users')
  }

  const { rows: uniq } = await pool.query(`
    SELECT pg_get_indexdef(i.oid) AS def FROM pg_class i
     WHERE i.relname = 'uq_donation_refunds_idempotency'
  `)
  if (!uniq.length || !/organization_id/.test(uniq[0].def) || !/idempotency_key/.test(uniq[0].def)) {
    throw new Error('125: org-scoped idempotency unique index is missing')
  }

  const { rows: oneVoid } = await pool.query(`
    SELECT pg_get_indexdef(i.oid) AS def FROM pg_class i
     WHERE i.relname = 'uq_donation_refunds_one_void'
  `)
  if (!oneVoid.length) throw new Error('125: the one-void unique index from 123 is missing')

  console.log('Migration 125: donation-void-refund-markers — done.')
}
