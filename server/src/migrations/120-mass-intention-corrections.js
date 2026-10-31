// Founder decision 8 (José, 2026-10-19): fulfilled Mass-intention history is
// preserved. After fulfilment there is no ordinary delete and no silent
// edit. An administrator may correct a row with a required reason, and an
// erroneous or duplicate row is VOIDED (with a reason), never removed.
//
// NUMBERING: 120, after 119-closed-address-suppression.
//
// Two additions:
//   1. ochr_mass_intentions.voided_at / voided_by / void_reason — a void
//      marks the row; the row itself stays in the book.
//   2. ochr_mass_intention_corrections — one row per correction or void:
//      who (actor_user_id), what (kind, reason, before/after of the
//      allowlisted columns), when (created_at). Tenant-scoped by
//      organization_id with the composite FK to the intention, so a
//      correction can never point at another parish's row.
//
// The before/after JSON holds the same parish text the book already holds
// (intention wording, requester). It is erased with the parish under the
// approved privacy process, not by this table. Additive only: no backfill,
// no rewrite of existing rows except the entered_history latch backfill
// (a boolean set on rows that are already fulfilled or stamped).

import pool from '../db.js'

export async function up() {
  console.log('Migration 120: mass-intention-corrections — applying...')
  await pool.query(`
    ALTER TABLE ochr_mass_intentions
      ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS voided_by   INTEGER,
      ADD COLUMN IF NOT EXISTS void_reason TEXT,
      ADD COLUMN IF NOT EXISTS entered_history BOOLEAN NOT NULL DEFAULT false
  `)
  // R339-1: "has entered protected history" is durable and monotonic.
  // Set once — by fulfilment, a stamp, a void, or a correction — and never
  // cleared, whatever the row's later status. The trigger enforces it for
  // every write path. The one-time backfill only marks rows that already
  // are fulfilled / stamped; it writes no date and invents no stamp.
  await pool.query(`
    CREATE OR REPLACE FUNCTION ochr_mass_intention_history_latch() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'UPDATE' AND OLD.entered_history THEN
        NEW.entered_history := true;
      END IF;
      IF NEW.status = 'fulfilled'
         OR NEW.fulfilled_mass_date IS NOT NULL
         OR NEW.fulfilled_mass_title IS NOT NULL
         OR NEW.fulfilled_mass_time IS NOT NULL
         OR NEW.voided_at IS NOT NULL THEN
        NEW.entered_history := true;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql
  `)
  await pool.query('DROP TRIGGER IF EXISTS ochr_mass_intention_history_latch ON ochr_mass_intentions')
  await pool.query(`CREATE TRIGGER ochr_mass_intention_history_latch
    BEFORE INSERT OR UPDATE ON ochr_mass_intentions
    FOR EACH ROW EXECUTE FUNCTION ochr_mass_intention_history_latch()`)
  // R339-4: the latch backfill must also reach rows of a HELD parish, which
  // migration 114's ochr_organization_hold_guard refuses (23514). The bypass
  // is narrow and transaction-local: one client, one transaction, this one
  // trigger on this one table, around this one latch-only statement. ALTER
  // TABLE takes ACCESS EXCLUSIVE, so no ordinary write can run while the
  // guard is off, and the ENABLE commits together with the backfill (any
  // error rolls both back, leaving the guard as it was). The guard function
  // itself is untouched.
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('ALTER TABLE ochr_mass_intentions DISABLE TRIGGER ochr_organization_hold_guard')
    await client.query(`
      UPDATE ochr_mass_intentions SET entered_history = true
       WHERE entered_history = false
         AND (status = 'fulfilled'
              OR fulfilled_mass_date IS NOT NULL
              OR fulfilled_mass_title IS NOT NULL
              OR fulfilled_mass_time IS NOT NULL)`)
    await client.query('ALTER TABLE ochr_mass_intentions ENABLE TRIGGER ochr_organization_hold_guard')
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  // Composite parent key so the correction's FK carries the tenant.
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'ochr_mass_intentions'::regclass
           AND conname = 'ochr_mass_intentions_id_org_key') THEN
        ALTER TABLE ochr_mass_intentions
          ADD CONSTRAINT ochr_mass_intentions_id_org_key UNIQUE (id, organization_id);
      END IF;
    END $$
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ochr_mass_intention_corrections (
      id                SERIAL PRIMARY KEY,
      organization_id   INTEGER NOT NULL REFERENCES ochr_organizations(id) ON DELETE CASCADE,
      mass_intention_id INTEGER NOT NULL,
      actor_user_id     INTEGER,
      kind              TEXT NOT NULL CHECK (kind IN ('correction', 'void')),
      reason            TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
      before            JSONB NOT NULL,
      after             JSONB NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (mass_intention_id, organization_id)
        REFERENCES ochr_mass_intentions(id, organization_id),
      -- R339-1: NO ACTION (not CASCADE). Deleting an intention never wipes
      -- its trail; only deleting the whole parish (both cascade from the
      -- organization in one statement) removes it.
      -- Tenant-FK ratchet: the actor is a login in the SAME parish.
      CONSTRAINT ochr_mi_corrections_actor_fk
        FOREIGN KEY (actor_user_id, organization_id)
        REFERENCES ochr_users(id, organization_id) ON DELETE SET NULL (actor_user_id)
    )
  `)
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ochr_mass_intentions_voided_by_fk') THEN
        ALTER TABLE ochr_mass_intentions
          ADD CONSTRAINT ochr_mass_intentions_voided_by_fk
          FOREIGN KEY (voided_by, organization_id)
          REFERENCES ochr_users(id, organization_id) ON DELETE SET NULL (voided_by);
      END IF;
    END $$
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS ochr_mi_corrections_row_idx
    ON ochr_mass_intention_corrections (organization_id, mass_intention_id, created_at)`)
  await pool.query('ALTER TABLE ochr_mass_intention_corrections ENABLE ROW LEVEL SECURITY')
  const { rows: roles } = await pool.query(
    `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`)
  for (const { rolname } of roles) {
    await pool.query(`REVOKE ALL ON ochr_mass_intention_corrections FROM ${rolname}`)
  }
  await pool.query('DROP TRIGGER IF EXISTS ochr_organization_hold_guard ON ochr_mass_intention_corrections')
  await pool.query(`CREATE TRIGGER ochr_organization_hold_guard
    BEFORE INSERT OR UPDATE OR DELETE ON ochr_mass_intention_corrections
    FOR EACH ROW EXECUTE FUNCTION ochr_held_organization_write_guard()`)
  console.log('Migration 120: mass-intention-corrections — done.')
}
