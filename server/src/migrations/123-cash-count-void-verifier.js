// 123 — cash counts: signed-in verifier and reasoned void (José, 21 Oct 2026,
// #62 comment 6330130546; TARS #357 6329834646 / 6330493971).
//
// ADDITIVE ONLY. New nullable columns, CHECKs on new columns only,
// tenant-composite FKs, one (id, organization_id) key, two partial unique
// indexes. No row is rewritten: counts confirmed before this
// migration keep verification = NULL and are read as "typed names (before
// signed-in verification)". Their counted_by / verified_by text stays.
//
//   ochr_cash_count_sessions
//     counted_by_user_id   the signed-in user who saved the count
//     confirmed_by_user_id the signed-in user who confirmed it
//     confirmed_by_name    snapshot of that user's name (survives user deletion)
//     confirmed_at         when
//     verification         'two_person' | 'single' | 'typed_names' (NULL = before 123)
//     voided_at / voided_by_user_id / voided_by_name / void_reason
//     void_refund_id       the reversing fact in ochr_donation_refunds
//
//   ochr_donation_refunds
//     kind   'refund' (default; every existing row) | 'void'
//     reason the void's stated reason
//
// A void is a posted ochr_donation_refunds row for the full posted gift. The
// gift row is never changed or deleted; ochr_donation_live and the parish
// ledger already net posted refund facts, so books, by-fund totals and giving
// statements reflect the void without a second accounting path. The 104 cap
// trigger (Σ ≤ gift) and a UNIQUE (donation_id) WHERE kind='void' index make a
// second reversal impossible even if a future route forgets the lock.

import pool from '../db.js'

export async function up() {
  console.log('Migration 123: cash-count-void-verifier — applying...')

  await pool.query(`
    ALTER TABLE ochr_cash_count_sessions
      ADD COLUMN IF NOT EXISTS counted_by_user_id   INTEGER,
      ADD COLUMN IF NOT EXISTS confirmed_by_user_id INTEGER,
      ADD COLUMN IF NOT EXISTS confirmed_by_name    TEXT,
      ADD COLUMN IF NOT EXISTS confirmed_at         TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS verification         TEXT,
      ADD COLUMN IF NOT EXISTS voided_at            TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS voided_by_user_id    INTEGER,
      ADD COLUMN IF NOT EXISTS voided_by_name       TEXT,
      ADD COLUMN IF NOT EXISTS void_reason          TEXT,
      ADD COLUMN IF NOT EXISTS void_refund_id       BIGINT
  `)
  // Tenant-composite FKs (the 071/079/109 pattern): a session can only name
  // a user or reversal of its own parish. Column-scoped SET NULL (PG15)
  // nulls only the user column when a user is deleted; the *_name
  // snapshots keep who it was. The reversal is RESTRICT: a void's
  // reversing fact cannot be removed from under it.
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_donation_refunds_id_org_key') THEN
        ALTER TABLE ochr_donation_refunds ADD CONSTRAINT ochr_donation_refunds_id_org_key UNIQUE (id, organization_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_cash_count_counted_by_user_fk') THEN
        ALTER TABLE ochr_cash_count_sessions ADD CONSTRAINT ochr_cash_count_counted_by_user_fk
          FOREIGN KEY (counted_by_user_id, organization_id)
          REFERENCES ochr_users (id, organization_id) ON DELETE SET NULL (counted_by_user_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_cash_count_confirmed_by_user_fk') THEN
        ALTER TABLE ochr_cash_count_sessions ADD CONSTRAINT ochr_cash_count_confirmed_by_user_fk
          FOREIGN KEY (confirmed_by_user_id, organization_id)
          REFERENCES ochr_users (id, organization_id) ON DELETE SET NULL (confirmed_by_user_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_cash_count_voided_by_user_fk') THEN
        ALTER TABLE ochr_cash_count_sessions ADD CONSTRAINT ochr_cash_count_voided_by_user_fk
          FOREIGN KEY (voided_by_user_id, organization_id)
          REFERENCES ochr_users (id, organization_id) ON DELETE SET NULL (voided_by_user_id);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_cash_count_void_refund_fk') THEN
        ALTER TABLE ochr_cash_count_sessions ADD CONSTRAINT ochr_cash_count_void_refund_fk
          FOREIGN KEY (void_refund_id, organization_id)
          REFERENCES ochr_donation_refunds (id, organization_id) ON DELETE RESTRICT;
      END IF;
    END $$
  `)
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_cash_count_verification_check') THEN
        ALTER TABLE ochr_cash_count_sessions ADD CONSTRAINT ochr_cash_count_verification_check
          CHECK (verification IS NULL OR verification IN ('two_person', 'single', 'typed_names'));
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_cash_count_void_complete') THEN
        ALTER TABLE ochr_cash_count_sessions ADD CONSTRAINT ochr_cash_count_void_complete
          CHECK (voided_at IS NULL OR (void_refund_id IS NOT NULL AND void_reason IS NOT NULL));
      END IF;
    END $$
  `)

  await pool.query(`
    ALTER TABLE ochr_donation_refunds
      ADD COLUMN IF NOT EXISTS kind   TEXT NOT NULL DEFAULT 'refund',
      ADD COLUMN IF NOT EXISTS reason TEXT
  `)
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_donation_refunds_kind_check') THEN
        ALTER TABLE ochr_donation_refunds ADD CONSTRAINT ochr_donation_refunds_kind_check
          CHECK (kind IN ('refund', 'void'));
      END IF;
    END $$
  `)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_donation_refunds_one_void
      ON ochr_donation_refunds (organization_id, donation_id) WHERE kind = 'void'
  `)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_count_void_refund
      ON ochr_cash_count_sessions (void_refund_id) WHERE void_refund_id IS NOT NULL
  `)
  console.log('Migration 123: cash-count-void-verifier — done.')
}
